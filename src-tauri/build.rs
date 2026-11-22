use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};

fn native_source_hash() -> String {
    // The probe independently hashes these checkout files before releasing the first document.
    let mut files = BTreeSet::new();
    for pattern in include_str!("native-source.inputs").lines() {
        let pattern = pattern.trim();
        let watch = pattern
            .split_once('*')
            .map_or(pattern, |(root, _)| root.trim_end_matches('/'));
        println!("cargo:rerun-if-changed=../{watch}");
        let matches = glob::glob(&format!("../{pattern}")).expect("valid native source glob");
        for path in matches {
            let path = path.expect("read native input");
            let name = path
                .strip_prefix("..")
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            files.insert(name);
        }
    }
    let mut hash = Sha256::new();
    for name in files {
        let path = Path::new("..").join(&name);
        let bytes = match path.extension().and_then(|s| s.to_str()) {
            Some("png" | "ico") => fs::read(&path).expect("read native resource"),
            _ => fs::read_to_string(&path)
                .expect("read native source")
                .replace("\r\n", "\n")
                .into_bytes(),
        };
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(Sha256::digest(&bytes));
    }
    format!("{:x}", hash.finalize())
}

fn main() {
    println!(
        "cargo:rustc-env=STUDIO_NATIVE_SOURCE_SHA256={}",
        native_source_hash()
    );
    tauri_build::build();
}
