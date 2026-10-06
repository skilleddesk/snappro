//! PDF export without any external tool.
//!
//! The goal is a PDF that prints like the picture looks: the original pixels are
//! embedded untouched (lossless Flate, or the original JPEG bytes), the page is a
//! real paper size (A4, Letter, ...) and the picture is scaled by the PDF itself,
//! so nothing is resampled or recompressed behind your back. Tall captures such as
//! scrolling screenshots can be cut into several pages.

use std::io::Write;
use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView, RgbImage};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfOptions {
    /// a4 | a3 | a5 | letter | legal | tabloid | image (page as big as the picture)
    pub page_size: String,
    /// auto | portrait | landscape
    pub orientation: String,
    /// none | small | normal | large
    pub margin: String,
    /// fit (whole picture, keeps proportions) | fill (cover the page, crops the edges) | actual (100%)
    pub fit: String,
    /// auto (best for each file) | lossless | high | small
    pub quality: String,
    /// 1, 2 or 4 pictures on one page
    pub per_page: u32,
    /// Cut very tall pictures (scrolling captures) into several pages.
    pub split_tall: bool,
    /// Do not blow small pictures up beyond their natural size.
    pub never_enlarge: bool,
    pub page_numbers: bool,
    /// Print the file name under each picture.
    pub captions: bool,
    /// Page colour, `#rrggbb`. Also what transparent pixels turn into.
    pub background: String,
    /// center | top
    pub align: String,
    /// Pixels per inch used for "image" pages and "actual" size.
    pub dpi: u32,
    pub title: Option<String>,
}

impl Default for PdfOptions {
    fn default() -> Self {
        Self {
            page_size: "a4".into(),
            orientation: "auto".into(),
            margin: "small".into(),
            fit: "fit".into(),
            quality: "auto".into(),
            per_page: 1,
            split_tall: true,
            never_enlarge: false,
            page_numbers: false,
            captions: false,
            background: "#ffffff".into(),
            align: "center".into(),
            dpi: 96,
            title: None,
        }
    }
}

/// Paper sizes in PDF points (1/72 inch), portrait.
pub fn paper_size(name: &str) -> Option<(f32, f32)> {
    match name {
        "a3" => Some((841.89, 1190.55)),
        "a4" => Some((595.28, 841.89)),
        "a5" => Some((419.53, 595.28)),
        "letter" => Some((612.0, 792.0)),
        "legal" => Some((612.0, 1008.0)),
        "tabloid" => Some((792.0, 1224.0)),
        _ => None,
    }
}

fn margin_points(name: &str) -> f32 {
    match name {
        "none" => 0.0,
        "normal" => 36.0,
        "large" => 54.0,
        _ => 18.0,
    }
}

/// One piece of a source picture placed on a page.
#[derive(Clone, Debug, PartialEq)]
pub struct Tile {
    pub source: usize,
    /// Part of the source in pixels: x, y, width, height.
    pub crop: (u32, u32, u32, u32),
    /// Where it goes on the page in points: x, y (from the bottom), width, height.
    pub rect: (f32, f32, f32, f32),
    /// The rectangle is bigger than the visible cell and has to be clipped.
    pub clip: Option<(f32, f32, f32, f32)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PagePlan {
    pub width: f32,
    pub height: f32,
    pub tiles: Vec<Tile>,
}

const LABEL_BAND: f32 = 14.0;

/// Work out the pages without touching any pixel (so it can be tested and previewed).
pub fn plan_pages(sizes: &[(u32, u32)], options: &PdfOptions) -> Vec<PagePlan> {
    let margin = margin_points(&options.margin);
    let dpi = options.dpi.clamp(36, 600) as f32;
    let per_page = match options.per_page {
        2 => 2,
        4 => 4,
        _ => 1,
    };
    let image_pages = options.page_size == "image";
    let mut pages: Vec<PagePlan> = Vec::new();
    let mut waiting: Vec<(usize, (u32, u32, u32, u32))> = Vec::new();

    let flush = |waiting: &mut Vec<(usize, (u32, u32, u32, u32))>, pages: &mut Vec<PagePlan>| {
        if waiting.is_empty() {
            return;
        }
        // A shared page takes the orientation of its first picture.
        let first = waiting[0].1;
        let (pw, ph) = page_dimensions(options, first.2, first.3, dpi, margin);
        let (cols, rows) = match per_page {
            2 => {
                if pw > ph {
                    (2, 1)
                } else {
                    (1, 2)
                }
            }
            4 => (2, 2),
            _ => (1, 1),
        };
        let bottom = margin + if options.page_numbers { LABEL_BAND } else { 0.0 };
        let area = (margin, bottom, pw - margin * 2.0, ph - margin - bottom);
        let gap = if per_page > 1 { 10.0 } else { 0.0 };
        let cell_w = (area.2 - gap * (cols as f32 - 1.0)) / cols as f32;
        let cell_h = (area.3 - gap * (rows as f32 - 1.0)) / rows as f32;
        let mut tiles = Vec::new();
        for (index, (source, crop)) in waiting.drain(..).enumerate() {
            let col = (index as u32 % cols) as f32;
            let row = (index as u32 / cols) as f32;
            let cell_x = area.0 + col * (cell_w + gap);
            // Rows count from the top of the page.
            let cell_y = area.1 + area.3 - (row + 1.0) * cell_h - row * gap;
            let label = if options.captions { LABEL_BAND } else { 0.0 };
            let avail = (cell_w, (cell_h - label).max(10.0));
            tiles.push(place_tile(source, crop, (cell_x, cell_y + label, avail.0, avail.1), options, dpi));
        }
        pages.push(PagePlan { width: pw, height: ph, tiles });
    };

    for (index, &(w, h)) in sizes.iter().enumerate() {
        if w == 0 || h == 0 {
            continue;
        }
        // Tall pictures become a run of full-width pages.
        if options.split_tall && !image_pages && options.fit != "actual" {
            let (pw, ph) = page_dimensions(options, w, h, dpi, margin);
            let label = (if options.captions { LABEL_BAND } else { 0.0 }) + if options.page_numbers { LABEL_BAND } else { 0.0 };
            let content_w = (pw - margin * 2.0).max(10.0);
            let content_h = (ph - margin * 2.0 - label).max(10.0);
            let scale = content_w / w as f32;
            let slice_px = (content_h / scale).floor().max(1.0) as u32;
            if h as f32 * scale > content_h * 1.25 && slice_px < h {
                flush(&mut waiting, &mut pages);
                let mut y = 0;
                while y < h {
                    let part = slice_px.min(h - y);
                    waiting.push((index, (0, y, w, part)));
                    flush_one_page(&mut waiting, &mut pages, &flush);
                    y += part;
                }
                continue;
            }
        }
        waiting.push((index, (0, 0, w, h)));
        if waiting.len() as u32 >= per_page {
            flush(&mut waiting, &mut pages);
        }
    }
    flush(&mut waiting, &mut pages);
    pages
}

fn flush_one_page(
    waiting: &mut Vec<(usize, (u32, u32, u32, u32))>,
    pages: &mut Vec<PagePlan>,
    flush: &impl Fn(&mut Vec<(usize, (u32, u32, u32, u32))>, &mut Vec<PagePlan>),
) {
    flush(waiting, pages);
}

fn page_dimensions(options: &PdfOptions, img_w: u32, img_h: u32, dpi: f32, margin: f32) -> (f32, f32) {
    if let Some((w, h)) = paper_size(&options.page_size) {
        let landscape = match options.orientation.as_str() {
            "landscape" => true,
            "portrait" => false,
            _ => img_w > img_h,
        };
        return if landscape { (h, w) } else { (w, h) };
    }
    // "image": the page is exactly as large as the picture at the chosen DPI.
    (img_w as f32 * 72.0 / dpi + margin * 2.0, img_h as f32 * 72.0 / dpi + margin * 2.0)
}

fn place_tile(
    source: usize,
    crop: (u32, u32, u32, u32),
    cell: (f32, f32, f32, f32),
    options: &PdfOptions,
    dpi: f32,
) -> Tile {
    let (cx, cy, cw, ch) = cell;
    let (iw, ih) = (crop.2 as f32, crop.3 as f32);
    let natural = 72.0 / dpi; // points per pixel at 100%
    let contain = (cw / iw).min(ch / ih);
    let mut scale = match options.fit.as_str() {
        "fill" => (cw / iw).max(ch / ih),
        "actual" => natural.min(contain),
        _ => contain,
    };
    if options.never_enlarge && options.fit != "fill" {
        scale = scale.min(natural);
    }
    let (w, h) = (iw * scale, ih * scale);
    let x = cx + (cw - w) / 2.0;
    let y = if options.align == "top" { cy + ch - h } else { cy + (ch - h) / 2.0 };
    let clip = if w > cw + 0.01 || h > ch + 0.01 { Some((cx, cy, cw, ch)) } else { None };
    Tile { source, crop, rect: (x, y, w, h), clip }
}

// ---------------------------------------------------------------------------
// Image encoding
// ---------------------------------------------------------------------------

struct Encoded {
    width: u32,
    height: u32,
    gray: bool,
    filter: &'static str,
    predictor: bool,
    data: Vec<u8>,
}

fn parse_color(hex: &str) -> [u8; 3] {
    let clean = hex.trim_start_matches('#');
    let value = |range: std::ops::Range<usize>| clean.get(range).and_then(|s| u8::from_str_radix(s, 16).ok()).unwrap_or(255);
    [value(0..2), value(2..4), value(4..6)]
}

fn flatten(image: &DynamicImage, background: [u8; 3]) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = px.0[3] as u32;
        let mix = |c: u8, b: u8| (((c as u32) * a + (b as u32) * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([mix(px.0[0], background[0]), mix(px.0[1], background[1]), mix(px.0[2], background[2])]));
    }
    out
}

fn flate(data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(6));
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

/// Lossless: raw RGB rows with the PNG "Up" filter, then Flate. UI screenshots shrink a lot.
fn encode_lossless(rgb: &RgbImage) -> anyhow::Result<Encoded> {
    let (w, h) = rgb.dimensions();
    let stride = w as usize * 3;
    let raw = rgb.as_raw();
    let mut filtered = Vec::with_capacity((stride + 1) * h as usize);
    for y in 0..h as usize {
        filtered.push(2u8); // PNG "Up"
        let row = &raw[y * stride..(y + 1) * stride];
        if y == 0 {
            filtered.extend_from_slice(row);
        } else {
            let previous = &raw[(y - 1) * stride..y * stride];
            filtered.extend(row.iter().zip(previous).map(|(a, b)| a.wrapping_sub(*b)));
        }
    }
    Ok(Encoded { width: w, height: h, gray: false, filter: "FlateDecode", predictor: true, data: flate(&filtered)? })
}

fn encode_jpeg(rgb: &RgbImage, quality: u8) -> anyhow::Result<Encoded> {
    let mut data = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut data, quality).encode_image(rgb)?;
    Ok(Encoded { width: rgb.width(), height: rgb.height(), gray: false, filter: "DCTDecode", predictor: false, data })
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
}

fn encode_tile(
    source: &DynamicImage,
    original: &[u8],
    tile: &Tile,
    options: &PdfOptions,
) -> anyhow::Result<Encoded> {
    let background = parse_color(&options.background);
    let (x, y, w, h) = tile.crop;
    let whole = x == 0 && y == 0 && w == source.width() && h == source.height();

    // A JPEG that is used as it is can go into the PDF byte for byte: no new loss.
    if whole && options.quality == "auto" && is_jpeg(original) {
        let kind = source.color();
        if matches!(kind, image::ColorType::Rgb8 | image::ColorType::L8) {
            return Ok(Encoded {
                width: w,
                height: h,
                gray: matches!(kind, image::ColorType::L8),
                filter: "DCTDecode",
                predictor: false,
                data: original.to_vec(),
            });
        }
    }
    let part = if whole { source.clone() } else { source.crop_imm(x, y, w, h) };
    let rgb = flatten(&part, background);
    match options.quality.as_str() {
        "high" => encode_jpeg(&rgb, 95),
        "small" => encode_jpeg(&rgb, 78),
        _ => encode_lossless(&rgb),
    }
}

// ---------------------------------------------------------------------------
// PDF writing
// ---------------------------------------------------------------------------

struct Writer {
    out: Vec<u8>,
    offsets: Vec<usize>,
}

impl Writer {
    fn new() -> Self {
        let mut out = Vec::new();
        out.extend_from_slice(b"%PDF-1.5\n%\xE2\xE3\xCF\xD3\n");
        Self { out, offsets: vec![0] }
    }

    /// Reserve an object number (objects can be written in any order).
    fn reserve(&mut self) -> usize {
        self.offsets.push(0);
        self.offsets.len() - 1
    }

    fn write(&mut self, number: usize, body: &[u8]) {
        self.offsets[number] = self.out.len();
        self.out.extend_from_slice(format!("{} 0 obj\n", number).as_bytes());
        self.out.extend_from_slice(body);
        self.out.extend_from_slice(b"\nendobj\n");
    }

    fn write_stream(&mut self, number: usize, dict: &str, data: &[u8]) {
        let mut body = format!("<< {} /Length {} >>\nstream\n", dict, data.len()).into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\nendstream");
        self.write(number, &body);
    }

    fn finish(mut self, root: usize, info: usize) -> Vec<u8> {
        let xref = self.out.len();
        self.out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", self.offsets.len()).as_bytes());
        for offset in self.offsets.iter().skip(1) {
            self.out.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        self.out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {} 0 R /Info {} 0 R >>\nstartxref\n{}\n%%EOF\n",
                self.offsets.len(),
                root,
                info,
                xref
            )
            .as_bytes(),
        );
        self.out
    }
}

fn pdf_text(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii() && !c.is_ascii_control() { c } else { '?' })
        .flat_map(|c| match c {
            '(' | ')' | '\\' => vec!['\\', c],
            other => vec![other],
        })
        .collect()
}

fn num(value: f32) -> String {
    format!("{:.3}", value)
}

/// Build a PDF from the pictures with the given options. Returns the size in bytes.
pub fn images_to_pdf_with(images: &[PathBuf], target: &Path, options: &PdfOptions) -> anyhow::Result<u64> {
    if images.is_empty() {
        anyhow::bail!("no images to export");
    }
    let mut sources: Vec<(DynamicImage, Vec<u8>, String)> = Vec::new();
    for path in images {
        let bytes = std::fs::read(path)?;
        let image = image::load_from_memory(&bytes)
            .map_err(|e| anyhow::anyhow!("{}: {}", path.display(), e))?;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        sources.push((image, bytes, name));
    }
    let sizes: Vec<(u32, u32)> = sources.iter().map(|(i, _, _)| i.dimensions()).collect();
    let plan = plan_pages(&sizes, options);
    if plan.is_empty() {
        anyhow::bail!("nothing to put on the pages");
    }

    let background = parse_color(&options.background);
    let mut writer = Writer::new();
    let catalog = writer.reserve();
    let tree = writer.reserve();
    let info = writer.reserve();
    let font = writer.reserve();
    writer.write(font, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

    let mut page_ids = Vec::new();
    for (page_index, page) in plan.iter().enumerate() {
        let page_id = writer.reserve();
        let content_id = writer.reserve();
        let mut content = String::new();
        content.push_str(&format!(
            "{:.3} {:.3} {:.3} rg 0 0 {} {} re f\n",
            background[0] as f32 / 255.0,
            background[1] as f32 / 255.0,
            background[2] as f32 / 255.0,
            num(page.width),
            num(page.height)
        ));
        let mut xobjects = String::new();
        for (tile_index, tile) in page.tiles.iter().enumerate() {
            let (image, original, name) = &sources[tile.source];
            let encoded = encode_tile(image, original, tile, options)?;
            let image_id = writer.reserve();
            let mut dict = format!(
                "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /Filter /{}",
                encoded.width,
                encoded.height,
                if encoded.gray { "DeviceGray" } else { "DeviceRGB" },
                encoded.filter
            );
            if encoded.predictor {
                dict.push_str(&format!(
                    " /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns {} >>",
                    encoded.width
                ));
            }
            // Smooth the picture when a viewer scales it, but keep hard pixels for tiny sources.
            dict.push_str(" /Interpolate true");
            writer.write_stream(image_id, &dict, &encoded.data);
            let label = format!("Im{}", tile_index);
            xobjects.push_str(&format!("/{} {} 0 R ", label, image_id));

            let (x, y, w, h) = tile.rect;
            content.push_str("q\n");
            if let Some((cx, cy, cw, ch)) = tile.clip {
                content.push_str(&format!("{} {} {} {} re W n\n", num(cx), num(cy), num(cw), num(ch)));
            }
            content.push_str(&format!("{} 0 0 {} {} {} cm\n/{} Do\nQ\n", num(w), num(h), num(x), num(y), label));
            if options.captions {
                content.push_str(&format!(
                    "BT /F1 7.5 Tf 0.35 0.35 0.35 rg {} {} Td ({}) Tj ET\n",
                    num(x.max(tile.clip.map(|c| c.0).unwrap_or(0.0))),
                    num(y.max(tile.clip.map(|c| c.1).unwrap_or(0.0)) - 10.0),
                    pdf_text(name)
                ));
            }
        }
        if options.page_numbers {
            let text = format!("{} / {}", page_index + 1, plan.len());
            content.push_str(&format!(
                "BT /F1 8 Tf 0.35 0.35 0.35 rg {} {} Td ({}) Tj ET\n",
                num(page.width / 2.0 - 12.0),
                num(margin_points(&options.margin).max(6.0)),
                pdf_text(&text)
            ));
        }
        writer.write_stream(content_id, "", content.as_bytes());
        writer.write(
            page_id,
            format!(
                "<< /Type /Page /Parent {} 0 R /MediaBox [0 0 {} {}] /Resources << /XObject << {}>> /Font << /F1 {} 0 R >> >> /Contents {} 0 R >>",
                tree, num(page.width), num(page.height), xobjects, font, content_id
            )
            .as_bytes(),
        );
        page_ids.push(page_id);
    }

    let kids = page_ids.iter().map(|id| format!("{} 0 R", id)).collect::<Vec<_>>().join(" ");
    writer.write(tree, format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids, page_ids.len()).as_bytes());
    writer.write(catalog, format!("<< /Type /Catalog /Pages {} 0 R /ViewerPreferences << /FitWindow true >> >>", tree).as_bytes());
    let title = options.title.clone().unwrap_or_else(|| "SnapPro".to_string());
    writer.write(
        info,
        format!(
            "<< /Title ({}) /Producer (SnapPro) /Creator (SnapPro) /CreationDate (D:{}) >>",
            pdf_text(&title),
            chrono::Local::now().format("%Y%m%d%H%M%S")
        )
        .as_bytes(),
    );

    let bytes = writer.finish(catalog, info);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target, &bytes)?;
    Ok(bytes.len() as u64)
}

/// Default options: A4, picture fitted, original quality.
pub fn images_to_pdf(images: &[PathBuf], target: &Path) -> anyhow::Result<u64> {
    images_to_pdf_with(images, target, &PdfOptions::default())
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    #[test]
    fn a4_is_a_real_paper_size() {
        let plan = plan_pages(&[(1920, 1080)], &PdfOptions::default());
        assert_eq!(plan.len(), 1);
        // landscape picture -> landscape A4
        assert!((plan[0].width - 841.89).abs() < 0.1 && (plan[0].height - 595.28).abs() < 0.1);
    }

    #[test]
    fn letter_portrait_forced() {
        let o = PdfOptions { page_size: "letter".into(), orientation: "portrait".into(), ..Default::default() };
        let plan = plan_pages(&[(1920, 1080)], &o);
        assert_eq!((plan[0].width, plan[0].height), (612.0, 792.0));
    }

    #[test]
    fn tall_capture_is_split_into_pages() {
        let plan = plan_pages(&[(1000, 6000)], &PdfOptions::default());
        assert!(plan.len() > 2, "pages: {}", plan.len());
        let total: u32 = plan.iter().flat_map(|p| p.tiles.iter()).map(|t| t.crop.3).sum();
        assert_eq!(total, 6000);
    }

    #[test]
    fn four_per_page() {
        let o = PdfOptions { per_page: 4, ..Default::default() };
        let plan = plan_pages(&[(800, 600); 5], &o);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].tiles.len(), 4);
    }

    #[test]
    fn image_page_matches_pixels() {
        let o = PdfOptions { page_size: "image".into(), margin: "none".into(), dpi: 72, ..Default::default() };
        let plan = plan_pages(&[(500, 300)], &o);
        assert_eq!((plan[0].width, plan[0].height), (500.0, 300.0));
    }

    #[test]
    fn jpeg_is_embedded_untouched_and_png_is_lossless() {
        let dir = std::env::temp_dir().join("snappro_pdf_test");
        std::fs::create_dir_all(&dir).unwrap();
        let img = image::RgbImage::from_fn(64, 48, |x, y| image::Rgb([(x * 4) as u8, (y * 5) as u8, 90]));
        let jpg = dir.join("a.jpg");
        img.save(&jpg).unwrap();
        let png = dir.join("b.png");
        img.save(&png).unwrap();
        let out = dir.join("o.pdf");
        images_to_pdf(&[jpg.clone(), png], &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let original = std::fs::read(&jpg).unwrap();
        assert!(bytes.windows(original.len()).any(|w| w == &original[..]), "jpeg bytes not passed through");
        assert!(bytes.windows(11).any(|w| w == b"FlateDecode"));
        assert!(bytes.ends_with(b"%%EOF\n"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
