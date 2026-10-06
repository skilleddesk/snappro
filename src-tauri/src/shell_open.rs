use std::path::Path;

use crate::util::hidden_command;

/// Show a file in the system file manager, with the file selected when possible.
#[cfg(windows)]
pub fn reveal(path: &Path) -> anyhow::Result<()> {
    // explorer wants `/select,"path"` as one raw argument; a normally quoted
    // argument made it open the Documents folder when the path had spaces.
    use std::os::windows::process::CommandExt;
    hidden_command("explorer")
        .raw_arg(format!("/select,\"{}\"", path.to_string_lossy()))
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn reveal(path: &Path) -> anyhow::Result<()> {
    hidden_command("open")
        .args(["-R", &path.to_string_lossy()])
        .spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn reveal(path: &Path) -> anyhow::Result<()> {
    let folder = path.parent().unwrap_or(path);
    hidden_command("xdg-open").arg(folder).spawn()?;
    Ok(())
}

/// Open a folder in the file manager.
#[cfg(windows)]
pub fn open_folder(path: &Path) -> anyhow::Result<()> {
    hidden_command("explorer").arg(path).spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn open_folder(path: &Path) -> anyhow::Result<()> {
    hidden_command("open").arg(path).spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn open_folder(path: &Path) -> anyhow::Result<()> {
    hidden_command("xdg-open").arg(path).spawn()?;
    Ok(())
}