//! Runtime library path for the prebuilt libduckdb (feature `duckdb`): the binary finds
//! `libduckdb.so` next to itself (`$ORIGIN`, the deployed layout) or in `DUCKDB_LIB_DIR`
//! (development builds and tests).
fn main() {
    println!("cargo:rerun-if-env-changed=DUCKDB_LIB_DIR");
    if std::env::var_os("CARGO_FEATURE_DUCKDB").is_none() {
        return;
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        if let Ok(dir) = std::env::var("DUCKDB_LIB_DIR") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
        }
    }
}
