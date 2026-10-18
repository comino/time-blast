mod caption;
mod config;
mod infer;
mod prompt;
mod provider;
mod service;
mod session;
mod sql;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = config::Config::from_env()?;
    service::serve(config).await
}
