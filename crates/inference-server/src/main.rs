mod config;
mod plan;
mod provider;
mod service;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = config::Config::from_env()?;
    service::serve(config).await
}
