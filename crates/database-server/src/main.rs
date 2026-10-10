#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = time_blast_database::config::Config::from_env()?;
    time_blast_database::service::serve(config).await
}
