use std::{env, net::SocketAddr, time::Duration};

use crate::provider::{ProviderConfig, ReasoningEffort};

pub struct Config {
    pub bind: SocketAddr,
    pub provider: ProviderConfig,
    pub allowed_origins: Vec<String>,
    pub requests_per_minute: u32,
    pub requests_per_day: u32,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let endpoint = env::var("TIME_BLAST_PROVIDER_URL")
            .unwrap_or_else(|_| "https://openrouter.ai/api/v1/chat/completions".into());
        let url = reqwest::Url::parse(&endpoint).map_err(|_| "Invalid provider URL")?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Provider URL must be HTTP(S), without credentials, query or fragment".into(),
            );
        }
        let openrouter = match env::var("TIME_BLAST_OPENROUTER").as_deref() {
            Ok("true") => true,
            Ok("false") => false,
            Ok(_) => return Err("TIME_BLAST_OPENROUTER must be true or false".into()),
            Err(_) => url.host_str() == Some("openrouter.ai"),
        };
        let api_key = env::var("TIME_BLAST_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                openrouter
                    .then(|| env::var("OPENROUTER_API_KEY").ok())
                    .flatten()
            })
            .filter(|s| !s.is_empty());
        let reasoning_effort = parse_reasoning_effort(
            env::var("TIME_BLAST_REASONING_EFFORT").ok().as_deref(),
            openrouter,
        )?;
        let temperature = parse_temperature(env::var("TIME_BLAST_TEMPERATURE").ok().as_deref())?;
        if openrouter && api_key.is_none() {
            return Err(
                "Set OPENROUTER_API_KEY or TIME_BLAST_API_KEY in the server environment".into(),
            );
        }
        let model =
            env::var("TIME_BLAST_MODEL").unwrap_or_else(|_| "google/gemini-2.5-flash-lite".into());
        if model.trim().is_empty() || model.len() > 200 {
            return Err("Invalid TIME_BLAST_MODEL".into());
        }
        let allowed_origins = env::var("TIME_BLAST_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://127.0.0.1:5173,http://localhost:5173,https://time-blast.46-224-133-201.sslip.io".into())
            .split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect::<Vec<_>>();
        if allowed_origins.is_empty()
            || allowed_origins
                .iter()
                .any(|s| s == "*" || reqwest::Url::parse(s).is_err())
        {
            return Err("TIME_BLAST_ALLOWED_ORIGINS must list explicit browser origins".into());
        }
        Ok(Self {
            bind: env::var("TIME_BLAST_BIND")
                .unwrap_or_else(|_| "127.0.0.1:8787".into())
                .parse()
                .map_err(|_| "Invalid TIME_BLAST_BIND")?,
            provider: ProviderConfig {
                endpoint,
                model,
                api_key,
                openrouter,
                reasoning_effort,
                temperature,
                timeout: Duration::from_secs(
                    number("TIME_BLAST_TIMEOUT_SECONDS", 25, 1, 30)? as u64
                ),
                max_concurrent: number("TIME_BLAST_MAX_CONCURRENT", 4, 1, 32)? as usize,
            },
            allowed_origins,
            requests_per_minute: number("TIME_BLAST_REQUESTS_PER_MINUTE", 30, 1, 10000)?,
            requests_per_day: number("TIME_BLAST_REQUESTS_PER_DAY", 1000, 1, 1000000)?,
        })
    }
}

fn parse_temperature(value: Option<&str>) -> Result<Option<f64>, String> {
    match value {
        None => Ok(Some(0.0)),
        Some("provider") => Ok(None),
        Some(value) => {
            let temperature: f64 = value.parse().map_err(
                |_| "TIME_BLAST_TEMPERATURE must be provider or a finite number between 0 and 2",
            )?;
            if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
                return Err(
                    "TIME_BLAST_TEMPERATURE must be provider or a finite number between 0 and 2"
                        .into(),
                );
            }
            Ok(Some(temperature))
        }
    }
}

fn parse_reasoning_effort(
    value: Option<&str>,
    openrouter: bool,
) -> Result<Option<ReasoningEffort>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !openrouter {
        return Err("TIME_BLAST_REASONING_EFFORT requires TIME_BLAST_OPENROUTER=true".into());
    }
    let effort = match value {
        "none" => ReasoningEffort::None,
        "minimal" => ReasoningEffort::Minimal,
        "low" => ReasoningEffort::Low,
        "medium" => ReasoningEffort::Medium,
        "high" => ReasoningEffort::High,
        _ => {
            return Err(
                "TIME_BLAST_REASONING_EFFORT must be none, minimal, low, medium or high".into(),
            );
        }
    };
    Ok(Some(effort))
}

fn number(name: &str, default: u32, min: u32, max: u32) -> Result<u32, String> {
    let value = match env::var(name) {
        Ok(s) => s.parse().map_err(|_| format!("Invalid {name}"))?,
        Err(_) => default,
    };
    if value < min || value > max {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temperature_defaults_to_zero_and_can_use_provider_default() {
        assert_eq!(parse_temperature(None).unwrap(), Some(0.0));
        assert_eq!(parse_temperature(Some("provider")).unwrap(), None);
        for (input, expected) in [("0", 0.0), ("0.5", 0.5), ("2", 2.0)] {
            assert_eq!(parse_temperature(Some(input)).unwrap(), Some(expected));
        }
        for invalid in ["", "NaN", "inf", "-inf", "-0.1", "2.1", "Provider", "null"] {
            assert!(parse_temperature(Some(invalid)).is_err());
        }
    }

    #[test]
    fn reasoning_is_unset_by_default_for_all_providers() {
        assert_eq!(parse_reasoning_effort(None, true).unwrap(), None);
        assert_eq!(parse_reasoning_effort(None, false).unwrap(), None);
    }

    #[test]
    fn explicit_reasoning_effort_accepts_only_supported_config_values() {
        for (value, expected) in [
            ("none", ReasoningEffort::None),
            ("minimal", ReasoningEffort::Minimal),
            ("low", ReasoningEffort::Low),
            ("medium", ReasoningEffort::Medium),
            ("high", ReasoningEffort::High),
        ] {
            assert_eq!(
                parse_reasoning_effort(Some(value), true).unwrap(),
                Some(expected)
            );
        }
        for invalid in [
            "",
            "false",
            "None",
            "low ",
            "xhigh",
            "max",
            "{\"effort\":\"none\"}",
        ] {
            assert!(parse_reasoning_effort(Some(invalid), true).is_err());
        }
    }

    #[test]
    fn reasoning_control_requires_openrouter() {
        assert!(parse_reasoning_effort(Some("none"), false).is_err());
        assert!(parse_reasoning_effort(Some("minimal"), false).is_err());
    }
}
