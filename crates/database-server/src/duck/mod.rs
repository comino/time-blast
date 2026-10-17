//! DuckDB backend: one database file opened **read-only** in this process through the C API
//! of the official prebuilt libduckdb (the same DuckDB version as the browser's DuckDB-Wasm, so
//! model SQL has one dialect everywhere).
//!
//! Safety comes from the execution environment, not from shrinking what the model may say:
//! - opened with `access_mode=READ_ONLY`, `enable_external_access=false` (no files, URLs,
//!   ATTACH, COPY, getenv), no extension install/autoload, community extensions off, and
//!   `lock_configuration=true` (no SET can loosen any of it);
//! - `memory_limit`, `threads`, `temp_directory` and `max_temp_directory_size` from config;
//! - each EXEC is exactly one statement, by DuckDB's own parser (`duckdb_extract_statements`),
//!   and must prepare as a `SELECT` statement (WITH, VALUES, FROM-first, PIVOT, DESCRIBE,
//!   SUMMARIZE, set operations); everything else is `sql_rejected` (see [`Statement::prepare`]).
//! - cancellation and timeouts interrupt the connection (`duckdb_interrupt`), repeatedly until
//!   the query has actually stopped ([`Control`]).
pub mod context;
pub mod exec;

use std::{
    ffi::{CStr, CString, c_char},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use arrow_array::{RecordBatch, StructArray, ffi::FFI_ArrowArray};
use arrow_schema::{DataType, Field, Schema, SchemaRef, ffi::FFI_ArrowSchema};
use libduckdb_sys as ffi;
use tokio::sync::Semaphore;

use crate::{clickhouse::Failure, config::DuckDbConfig};

struct DbHandle(ffi::duckdb_database);
// A DuckDB database handle may be used from any thread; connections are created from it.
unsafe impl Send for DbHandle {}
unsafe impl Sync for DbHandle {}

/// One DuckDB connection. Used by one thread at a time (moved, never shared), except for
/// `duckdb_interrupt`, which DuckDB allows from another thread.
pub struct Conn(ffi::duckdb_connection);
unsafe impl Send for Conn {}

impl Drop for Conn {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_disconnect(&mut self.0) };
    }
}

pub struct DuckDb {
    db: DbHandle,
    pool: Mutex<Vec<Conn>>,
    pub config: DuckDbConfig,
    /// Model queries running at once (all sessions); a permit lives as long as DuckDB works.
    pub queries: Arc<Semaphore>,
    /// Queries whose worker thread has not returned yet (health, tests).
    pub running: AtomicUsize,
    pub version: String,
}

impl Drop for DuckDb {
    fn drop(&mut self) {
        self.pool.lock().unwrap().clear();
        unsafe { ffi::duckdb_close(&mut self.db.0) };
    }
}

fn cstr(text: *const c_char) -> Option<String> {
    (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

/// DuckDB error text → protocol-v1 ERROR code. DuckDB prefixes messages with the exception
/// type (`Binder Error: …`), as DuckDB-Wasm does in the browser.
pub fn failure(message: String) -> Failure {
    let code = if message.starts_with("Permission Error") {
        "sql_rejected" // external access, ATTACH, …: refused by configuration
    } else if message.starts_with("INTERRUPT Error") || message.starts_with("Interrupt") {
        "timeout" // only reported when the interrupt was a timeout (a cancel sends nothing)
    } else if message.starts_with("Out of Memory Error") {
        "result_limit"
    } else {
        "sql_error"
    };
    Failure::new(code, message)
}

impl DuckDb {
    /// Open the file read-only with the locked-down configuration.
    pub fn open(config: DuckDbConfig) -> Result<DuckDb, String> {
        if !config.path.is_file() {
            return Err(format!("DuckDB file {} does not exist", config.path.display()));
        }
        std::fs::create_dir_all(&config.temp_directory)
            .map_err(|e| format!("temp directory {}: {e}", config.temp_directory.display()))?;
        let temp = config.temp_directory.to_str().ok_or("temp directory must be UTF-8")?.to_string();
        let threads = config.threads.to_string();
        let options: [(&str, &str); 11] = [
            ("access_mode", "READ_ONLY"),
            ("threads", &threads),
            ("memory_limit", &config.memory_limit),
            ("temp_directory", &temp),
            ("max_temp_directory_size", &config.max_temp_size),
            ("autoinstall_known_extensions", "false"),
            ("autoload_known_extensions", "false"),
            ("allow_community_extensions", "false"),
            ("allow_unsigned_extensions", "false"),
            ("enable_external_access", "false"),
            ("lock_configuration", "true"),
        ];
        unsafe {
            let mut cfg: ffi::duckdb_config = ptr::null_mut();
            if ffi::duckdb_create_config(&mut cfg) != ffi::DuckDBSuccess {
                return Err("duckdb_create_config failed".into());
            }
            struct Cfg(ffi::duckdb_config);
            impl Drop for Cfg {
                fn drop(&mut self) {
                    unsafe { ffi::duckdb_destroy_config(&mut self.0) };
                }
            }
            let cfg = Cfg(cfg);
            for (name, value) in options {
                let (n, v) = (CString::new(name).unwrap(), CString::new(value).map_err(|_| format!("invalid {name}"))?);
                if ffi::duckdb_set_config(cfg.0, n.as_ptr(), v.as_ptr()) != ffi::DuckDBSuccess {
                    return Err(format!("DuckDB rejected setting {name}={value}"));
                }
            }
            let path = CString::new(config.path.to_str().ok_or("DuckDB path must be UTF-8")?).map_err(|_| "invalid path")?;
            let mut db: ffi::duckdb_database = ptr::null_mut();
            let mut error: *mut c_char = ptr::null_mut();
            if ffi::duckdb_open_ext(path.as_ptr(), &mut db, cfg.0, &mut error) != ffi::DuckDBSuccess {
                let message = cstr(error).unwrap_or_else(|| "unknown error".into());
                if !error.is_null() {
                    ffi::duckdb_free(error.cast());
                }
                return Err(format!("open {}: {message}", config.path.display()));
            }
            let version = cstr(ffi::duckdb_library_version()).unwrap_or_default();
            let queries = Arc::new(Semaphore::new(config.max_queries));
            Ok(DuckDb { db: DbHandle(db), pool: Mutex::new(Vec::new()), config, queries, running: AtomicUsize::new(0), version })
        }
    }

    pub fn file_name(&self) -> String {
        self.config.path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// A pooled connection (or a new one: `duckdb_connect` costs microseconds).
    pub fn checkout(&self) -> Result<Conn, Failure> {
        if let Some(conn) = self.pool.lock().unwrap().pop() {
            return Ok(conn);
        }
        let mut raw: ffi::duckdb_connection = ptr::null_mut();
        if unsafe { ffi::duckdb_connect(self.db.0, &mut raw) } != ffi::DuckDBSuccess {
            return Err(Failure::new("unavailable", "duckdb_connect failed"));
        }
        Ok(Conn(raw))
    }

    pub fn checkin(&self, conn: Conn) {
        let mut pool = self.pool.lock().unwrap();
        if pool.len() < 64 {
            pool.push(conn);
        }
    }

    /// Cold path: run trusted SQL to completion under `deadline` and collect its batches.
    pub fn collect(&self, sql: &str, deadline: Instant) -> Result<Vec<RecordBatch>, Failure> {
        let conn = self.checkout()?;
        let control = Arc::new(Control::default());
        control.attach(&conn);
        let watchdog = control.clone();
        let timer = std::thread::spawn(move || {
            while !watchdog.finished.load(Ordering::Acquire) {
                if Instant::now() >= deadline {
                    watchdog.interrupt_until_finished();
                    return;
                }
                std::thread::park_timeout(Duration::from_millis(20));
            }
        });
        let result = (|| {
            let mut stream = Statement::prepare(&conn, sql)?.execute()?;
            let mut out = Vec::new();
            while let Some(batch) = stream.next()? {
                out.push(batch);
            }
            Ok(out)
        })();
        control.detach();
        control.finished.store(true, Ordering::Release);
        timer.thread().unpark();
        let _ = timer.join();
        self.checkin(conn);
        result.map_err(|f: Failure| if Instant::now() >= deadline { Failure::new("timeout", f.message) } else { f })
    }
}

// ───────────────────────── interrupt ─────────────────────────

/// Stops a query from another thread. `duckdb_interrupt` only affects a query that is running
/// (DuckDB clears the flag when the next query starts), so a cancel that lands between prepare
/// and execute would be lost: the canceller re-interrupts every few milliseconds until the
/// worker reports `finished`. The connection pointer is only touched under the mutex while the
/// worker has it attached, so an interrupt never reaches a connection back in the pool.
#[derive(Default)]
pub struct Control {
    conn: Mutex<Option<usize>>,
    pub cancelled: AtomicBool,
    pub finished: AtomicBool,
}

impl Control {
    pub fn attach(&self, conn: &Conn) {
        *self.conn.lock().unwrap() = Some(conn.0 as usize);
    }
    pub fn detach(&self) {
        *self.conn.lock().unwrap() = None;
    }
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn interrupt(&self) {
        if let Some(raw) = *self.conn.lock().unwrap() {
            unsafe { ffi::duckdb_interrupt(raw as ffi::duckdb_connection) };
        }
    }
    /// Mark cancelled and interrupt until the worker is done (bounded at 60 s).
    pub fn interrupt_until_finished(&self) {
        self.cancelled.store(true, Ordering::Release);
        let started = Instant::now();
        while !self.finished.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(60) {
            self.interrupt();
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    /// Cancel from async code without blocking the runtime.
    pub fn cancel(self: &Arc<Self>) {
        if self.cancelled.swap(true, Ordering::AcqRel) || self.finished.load(Ordering::Acquire) {
            return;
        }
        self.interrupt();
        let control = self.clone();
        std::thread::spawn(move || control.interrupt_until_finished());
    }
}

// ───────────────────────── statements and streams ─────────────────────────

struct Extracted(ffi::duckdb_extracted_statements);
impl Drop for Extracted {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_destroy_extracted(&mut self.0) };
    }
}

/// A prepared, guarded statement: exactly one statement, of type SELECT.
pub struct Statement<'c> {
    raw: ffi::duckdb_prepared_statement,
    _conn: &'c Conn,
}

impl Drop for Statement<'_> {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_destroy_prepare(&mut self.raw) };
    }
}

pub const MULTIPLE: &str = "Only one SQL statement may be executed";
pub const EMPTY: &str = "The SQL text contains no statement";
pub const NOT_A_QUERY: &str = "Only read-only queries (SELECT, WITH, VALUES, FROM, PIVOT, DESCRIBE, SUMMARIZE) may be executed";

impl<'c> Statement<'c> {
    /// The guard. DuckDB's own parser splits the text (`duckdb_extract_statements`, so strings,
    /// quoted identifiers, dollar quotes and comments are handled exactly as the parser does):
    /// 0 statements → `sql_rejected` (or the parse error), more than 1 → `sql_rejected`. The
    /// one statement is prepared (bound and planned, not run) and must be a SELECT statement.
    pub fn prepare(conn: &'c Conn, sql: &str) -> Result<Statement<'c>, Failure> {
        let text = CString::new(sql).map_err(|_| Failure::new("sql_rejected", "SQL must not contain NUL bytes"))?;
        unsafe {
            let mut extracted = Extracted(ptr::null_mut());
            let count = ffi::duckdb_extract_statements(conn.0, text.as_ptr(), &mut extracted.0);
            if count == 0 {
                return Err(match cstr(ffi::duckdb_extract_statements_error(extracted.0)).filter(|m| !m.is_empty()) {
                    Some(message) => failure(message),
                    None => Failure::new("sql_rejected", EMPTY),
                });
            }
            if count > 1 {
                return Err(Failure::new("sql_rejected", MULTIPLE));
            }
            let mut statement = Statement { raw: ptr::null_mut(), _conn: conn };
            if ffi::duckdb_prepare_extracted_statement(conn.0, extracted.0, 0, &mut statement.raw) != ffi::DuckDBSuccess {
                return Err(failure(cstr(ffi::duckdb_prepare_error(statement.raw)).unwrap_or_else(|| "prepare failed".into())));
            }
            if ffi::duckdb_prepared_statement_type(statement.raw) != ffi::duckdb_statement_type_DUCKDB_STATEMENT_TYPE_SELECT {
                return Err(Failure::new("sql_rejected", NOT_A_QUERY));
            }
            if ffi::duckdb_nparams(statement.raw) > 0 {
                return Err(Failure::new("sql_rejected", "Query parameters ($1, ?) cannot be bound here"));
            }
            Ok(statement)
        }
    }

    /// Start executing as a streaming result: returns once the result's schema is known; rows
    /// are produced chunk by chunk by [`Stream::next`].
    pub fn execute(self) -> Result<Stream<'c>, Failure> {
        unsafe {
            let mut result: ffi::duckdb_result = std::mem::zeroed();
            if ffi::duckdb_execute_prepared_streaming(self.raw, &mut result) != ffi::DuckDBSuccess {
                let message = cstr(ffi::duckdb_result_error(&mut result)).unwrap_or_else(|| "execution failed".into());
                ffi::duckdb_destroy_result(&mut result);
                return Err(failure(message));
            }
            let mut stream = Stream {
                result,
                options: ptr::null_mut(),
                schema: Arc::new(Schema::empty()),
                struct_type: DataType::Null,
                _statement: self,
            };
            stream.options = ffi::duckdb_result_get_arrow_options(&mut stream.result);
            let columns = ffi::duckdb_column_count(&mut stream.result);
            let mut names: Vec<*const c_char> = (0..columns).map(|i| ffi::duckdb_column_name(&mut stream.result, i)).collect();
            let mut types: Vec<ffi::duckdb_logical_type> =
                (0..columns).map(|i| ffi::duckdb_column_logical_type(&mut stream.result, i)).collect();
            let mut ffi_schema = FFI_ArrowSchema::empty();
            let error = ffi::duckdb_to_arrow_schema(
                stream.options,
                types.as_mut_ptr(),
                names.as_mut_ptr(),
                columns,
                (&mut ffi_schema as *mut FFI_ArrowSchema).cast(),
            );
            for t in types.iter_mut() {
                ffi::duckdb_destroy_logical_type(t);
            }
            take_error(error)?;
            let schema = Schema::try_from(&ffi_schema).map_err(|e| Failure::new("sql_error", format!("Arrow schema: {e}")))?;
            stream.struct_type = DataType::Struct(schema.fields().clone());
            stream.schema = Arc::new(schema);
            Ok(stream)
        }
    }
}

fn take_error(mut error: ffi::duckdb_error_data) -> Result<(), Failure> {
    if error.is_null() {
        return Ok(());
    }
    unsafe {
        let failed = ffi::duckdb_error_data_has_error(error);
        let message = cstr(ffi::duckdb_error_data_message(error)).unwrap_or_default();
        ffi::duckdb_destroy_error_data(&mut error);
        if failed { Err(failure(message)) } else { Ok(()) }
    }
}

/// A streaming result: DuckDB data chunks (≤ 2,048 rows) converted by DuckDB to the Arrow C
/// data interface and imported without copying (the RecordBatch owns DuckDB's buffers).
pub struct Stream<'c> {
    result: ffi::duckdb_result,
    options: ffi::duckdb_arrow_options,
    pub schema: SchemaRef,
    struct_type: DataType,
    _statement: Statement<'c>,
}

impl Drop for Stream<'_> {
    fn drop(&mut self) {
        unsafe {
            if !self.options.is_null() {
                ffi::duckdb_destroy_arrow_options(&mut self.options);
            }
            ffi::duckdb_destroy_result(&mut self.result);
        }
    }
}

struct Chunk(ffi::duckdb_data_chunk);
impl Drop for Chunk {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_destroy_data_chunk(&mut self.0) };
    }
}

impl Stream<'_> {
    /// The next non-empty batch, `None` at the end. Blocks while DuckDB computes it.
    pub fn next(&mut self) -> Result<Option<RecordBatch>, Failure> {
        unsafe {
            loop {
                let chunk = Chunk(ffi::duckdb_fetch_chunk(self.result));
                if chunk.0.is_null() {
                    return match cstr(ffi::duckdb_result_error(&mut self.result)) {
                        Some(message) => Err(failure(message)),
                        None => Ok(None),
                    };
                }
                if ffi::duckdb_data_chunk_get_size(chunk.0) == 0 {
                    continue;
                }
                let mut array = FFI_ArrowArray::empty();
                take_error(ffi::duckdb_data_chunk_to_arrow(self.options, chunk.0, (&mut array as *mut FFI_ArrowArray).cast()))?;
                drop(chunk);
                let data = arrow_array::ffi::from_ffi_and_data_type(array, self.struct_type.clone())
                    .map_err(|e| Failure::new("sql_error", format!("Arrow import: {e}")))?;
                let batch = RecordBatch::from(StructArray::from(data));
                // Field metadata/nullability as in the schema message.
                return Ok(Some(batch.with_schema(self.schema.clone()).map_err(|e| Failure::new("sql_error", e.to_string()))?));
            }
        }
    }
}

/// Dictionary-encoded columns (DuckDB `ENUM`) as their value type: tb1 BATCH frames carry
/// record batches only, never dictionary batches. `None` when nothing needs a cast.
pub fn undictionary(schema: &Schema) -> Option<SchemaRef> {
    if !schema.fields().iter().any(|f| matches!(f.data_type(), DataType::Dictionary(..))) {
        return None;
    }
    let fields: Vec<Field> = schema
        .fields()
        .iter()
        .map(|f| match f.data_type() {
            DataType::Dictionary(_, value) => f.as_ref().clone().with_data_type(value.as_ref().clone()),
            _ => f.as_ref().clone(),
        })
        .collect();
    Some(Arc::new(Schema::new_with_metadata(fields, schema.metadata().clone())))
}

pub fn cast_batch(batch: &RecordBatch, target: &SchemaRef) -> Result<RecordBatch, Failure> {
    let columns = batch
        .columns()
        .iter()
        .zip(target.fields())
        .map(|(c, f)| if c.data_type() == f.data_type() { Ok(c.clone()) } else { arrow_cast::cast(c, f.data_type()) })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| Failure::new("sql_error", format!("ENUM cast: {e}")))?;
    RecordBatch::try_new(target.clone(), columns).map_err(|e| Failure::new("sql_error", e.to_string()))
}

