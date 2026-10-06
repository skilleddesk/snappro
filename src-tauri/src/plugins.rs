use serde::{Deserialize, Serialize};

/// A plugin is a small JSON manifest plus an optional JS file that SnapPro can run
/// inside the editor sandbox. The manifest declares what the plugin adds.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    /// Toolbar buttons the plugin contributes, e.g. "Vintage filter".
    #[serde(default)]
    pub tools: Vec<PluginTool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginTool {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    /// Filter expression applied to the canvas: "grayscale", "sepia", "invert", "vintage"...
    pub effect: Option<String>,
    pub amount: Option<f64>,
}

pub fn plugin_dir() -> std::path::PathBuf {
    crate::util::plugins_dir()
}

/// Write the two example plugins the first time SnapPro runs, so the plugin
/// manager always has something to show.
pub fn ensure_examples() {
    let dir = plugin_dir();
    let _ = std::fs::create_dir_all(&dir);

    let vintage = PluginManifest {
        id: "com.snappro.vintage".into(),
        name: "Vintage Filters".into(),
        version: Some("1.0.0".into()),
        description: Some("Warm film-style filters for your screenshots.".into()),
        author: Some("SnapPro".into()),
        tools: vec![
            PluginTool {
                id: "vintage-warm".into(),
                label: "Warm Film".into(),
                icon: Some("sun".into()),
                effect: Some("sepia".into()),
                amount: Some(0.35),
            },
            PluginTool {
                id: "vintage-mono".into(),
                label: "Soft Mono".into(),
                icon: Some("circle".into()),
                effect: Some("grayscale".into()),
                amount: Some(0.9),
            },
        ],
    };

    let social = PluginManifest {
        id: "com.snappro.social".into(),
        name: "Social Presets".into(),
        version: Some("1.0.0".into()),
        description: Some("Square and story sized export presets.".into()),
        author: Some("SnapPro".into()),
        tools: vec![
            PluginTool {
                id: "social-square".into(),
                label: "Square 1:1".into(),
                icon: Some("square".into()),
                effect: Some("crop".into()),
                amount: Some(1.0),
            },
            PluginTool {
                id: "social-story".into(),
                label: "Story 9:16".into(),
                icon: Some("smartphone".into()),
                effect: Some("crop".into()),
                amount: Some(0.5625),
            },
        ],
    };

    for manifest in [vintage, social] {
        let path = dir.join(format!("{}.json", manifest.id));
        if !path.exists() {
            if let Ok(text) = serde_json::to_string_pretty(&manifest) {
                let _ = std::fs::write(path, text);
            }
        }
    }
}

/// Load every plugin manifest found in the plugin folder.
pub fn list_plugins() -> Vec<PluginManifest> {
    ensure_examples();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugin_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&text) {
                        out.push(manifest);
                    }
                }
            }
        }
    }
    out
}

/// Import a plugin manifest from anywhere on disk into the plugin folder.
pub fn install_plugin(source: &std::path::Path) -> anyhow::Result<PluginManifest> {
    let text = std::fs::read_to_string(source)?;
    let manifest: PluginManifest = serde_json::from_str(&text)?;
    let dir = plugin_dir();
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}.json", manifest.id));
    std::fs::write(target, serde_json::to_string_pretty(&manifest)?)?;
    Ok(manifest)
}

pub fn remove_plugin(id: &str) -> anyhow::Result<()> {
    let path = plugin_dir().join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn open_plugin_folder() -> anyhow::Result<()> {
    let dir = plugin_dir();
    std::fs::create_dir_all(&dir)?;
    crate::shell_open::open_folder(&dir)
}