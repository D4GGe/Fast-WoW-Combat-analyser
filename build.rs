use std::path::Path;

fn main() {
    let logo_path = Path::new("assets/logo.png");
    let ico_path = Path::new("assets/icon.ico");

    // Wrap the full logo PNG in an ICO container for the Windows app icon
    if logo_path.exists() && !ico_path.exists() {
        let png_data = std::fs::read(logo_path).expect("Failed to read logo.png");
        let data_len = png_data.len() as u32;

        let mut ico: Vec<u8> = Vec::new();
        // ICO header: reserved(2) + type=1(2) + count=1(2)
        ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
        // Directory entry: width=0(256), height=0(256), colors=0, reserved=0, planes=1, bpp=32
        ico.push(0); // width (0 = 256)
        ico.push(0); // height (0 = 256)
        ico.push(0); // color count
        ico.push(0); // reserved
        ico.extend_from_slice(&1u16.to_le_bytes()); // color planes
        ico.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        ico.extend_from_slice(&data_len.to_le_bytes()); // data size
        ico.extend_from_slice(&22u32.to_le_bytes()); // offset (6 header + 16 entry = 22)
        // PNG data
        ico.extend_from_slice(&png_data);

        std::fs::write(ico_path, ico).expect("Failed to write icon.ico");
    }

    // Embed ICO as Windows resource
    if cfg!(target_os = "windows") && ico_path.exists() {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.compile().expect("Failed to compile Windows resource");
    }
}
