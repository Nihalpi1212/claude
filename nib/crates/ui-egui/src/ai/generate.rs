//! The Generate window: one floating window for every generative feature, its feature chosen by
//! the command that opened it (Window › Generate shows Text to Vector Graphic). It holds the
//! prompt and the feature's options, **Generate** / **Stop** with a spinner and the elapsed time,
//! the error of the last request with what fixes it, and the results as thumbnails, palettes or
//! texts: a click on one places it (`ai.panel.place`) as one undo step, and another click (after Undo, or
//! on another result) places again.
//!
//! The window doesn't block the app: the request runs on a worker thread and editing goes on.

use std::time::Instant;

use nib_genai::jobs::{JobId, Outcome};
use nib_genai::ops::{ExpandSpec, Generated, PatternSpec, Preview, RecolorSpec, RewriteSpec, ShapeFillSpec, TextToVectorSpec, VectorMethod};
use nib_genai::prompts::{Detail, Tone, VectorKind};
use nib_genai::{AiError, ErrorKind, Feature, FeatureRequest, ProviderKind};
use serde_json::{Value, json};

use super::{fixed_in_accounts, message, retryable, unsuitable};
use crate::VectorcraftApp;
use crate::theme::Tokens;
use crate::widgets;

/// The longest prompt kept (characters).
pub const MAX_PROMPT: usize = 4000;
/// A thumbnail's longest side, in pixels.
const THUMB_PX: u32 = 192;
/// A thumbnail's side on screen, in points.
const THUMB_PT: f32 = 92.0;
/// The window's content width.
const WIDTH: f32 = 340.0;

/// Rewrite Text's tones as the window lists them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ToneChoice {
    #[default]
    Shorter,
    Longer,
    Formal,
    Casual,
    FixSpelling,
    Custom,
}

impl ToneChoice {
    const ALL: [ToneChoice; 6] =
        [ToneChoice::Shorter, ToneChoice::Longer, ToneChoice::Formal, ToneChoice::Casual, ToneChoice::FixSpelling, ToneChoice::Custom];

    fn label(self) -> &'static str {
        match self {
            ToneChoice::Shorter => tl!("Shorter"),
            ToneChoice::Longer => tl!("Longer"),
            ToneChoice::Formal => tl!("More Formal"),
            ToneChoice::Casual => tl!("More Casual"),
            ToneChoice::FixSpelling => tl!("Fix Spelling"),
            ToneChoice::Custom => tl!("Custom"),
        }
    }
}

/// What the window shows of a result.
pub(crate) enum Thumb {
    /// A picture (SVG drawn, PNG decoded) and its texture once uploaded.
    Image { image: egui::ColorImage, tex: Option<egui::TextureHandle> },
    /// A palette's name and colours.
    Palette(String, Vec<egui::Color32>),
    /// Rewritten text.
    Text(String),
    /// Nothing to show (an SVG the preview couldn't draw): it can still be placed.
    Blank,
}

/// The result of the last request.
pub(crate) struct Shown {
    pub job: JobId,
    pub feature: Feature,
    pub items: Vec<Thumb>,
}

/// The Generate window's state. Nothing here is saved or sent anywhere but in a request.
pub(crate) struct Panel {
    pub open: bool,
    pub feature: Feature,
    pub prompt: String,
    pub kind: VectorKind,
    pub detail: Detail,
    pub method: VectorMethod,
    pub variations: u8,
    pub style_reference: bool,
    pub use_shape_colors: bool,
    pub tile_size: f64,
    pub apply_to_selection: bool,
    /// Generative Expand: points added on every side.
    pub margin: f64,
    pub fill_artboard: bool,
    pub tone: ToneChoice,
    pub custom_tone: String,
    /// `None`: the default provider.
    pub provider: Option<ProviderKind>,
    /// The request running and when it started.
    pub job: Option<(JobId, Instant)>,
    pub result: Option<Shown>,
    pub error: Option<AiError>,
    /// What happened last ("Placed result 2", "Stopped").
    pub note: Option<String>,
}

impl Default for Panel {
    fn default() -> Self {
        Self {
            open: false,
            feature: Feature::TextToVector,
            prompt: String::new(),
            kind: VectorKind::default(),
            detail: Detail::default(),
            method: VectorMethod::default(),
            variations: 2,
            style_reference: false,
            use_shape_colors: false,
            tile_size: 100.0,
            apply_to_selection: false,
            margin: 72.0,
            fill_artboard: false,
            tone: ToneChoice::default(),
            custom_tone: String::new(),
            provider: None,
            job: None,
            result: None,
            error: None,
            note: None,
        }
    }
}

impl Panel {
    /// The request the window's fields describe.
    pub fn request(&self) -> FeatureRequest {
        let prompt = self.prompt.trim().to_string();
        let variations = self.variations.clamp(1, 4);
        match self.feature {
            Feature::TextToVector => FeatureRequest::TextToVector(TextToVectorSpec {
                prompt,
                kind: self.kind,
                detail: self.detail,
                method: self.method,
                variations,
                palette: vec![],
                style_reference: self.style_reference,
            }),
            Feature::ShapeFill => FeatureRequest::ShapeFill(ShapeFillSpec {
                prompt,
                detail: self.detail,
                method: self.method,
                variations,
                use_shape_colors: self.use_shape_colors,
                palette: vec![],
            }),
            Feature::Pattern => FeatureRequest::Pattern(PatternSpec {
                prompt,
                detail: self.detail,
                method: self.method,
                variations,
                palette: vec![],
                tile_size: Some(self.tile_size.clamp(4.0, 4000.0)),
                apply_to_selection: self.apply_to_selection,
            }),
            Feature::Expand => {
                let m = self.margin.clamp(0.0, 10_000.0);
                FeatureRequest::Expand(ExpandSpec { prompt, margins: [m; 4], fill_artboard: self.fill_artboard })
            }
            Feature::Recolor => FeatureRequest::Recolor(RecolorSpec { prompt, samples: vec![], variations }),
            Feature::Rewrite => FeatureRequest::Rewrite(RewriteSpec { tone: self.tone(), variations }),
        }
    }

    fn tone(&self) -> Tone {
        match self.tone {
            ToneChoice::Shorter => Tone::Shorter,
            ToneChoice::Longer => Tone::Longer,
            ToneChoice::Formal => Tone::Formal,
            ToneChoice::Casual => Tone::Casual,
            ToneChoice::FixSpelling => Tone::FixSpelling,
            ToneChoice::Custom => Tone::Custom(self.custom_tone.trim().to_string()),
        }
    }

    /// The feature asks for a prompt (Expand's is optional, Rewrite has a tone instead).
    fn needs_prompt(&self) -> bool {
        matches!(self.feature, Feature::TextToVector | Feature::ShapeFill | Feature::Pattern | Feature::Recolor)
    }
}

/// Show the window on `feature`. Another feature's request still running is stopped, and its
/// result forgotten.
pub(crate) fn show_feature(app: &mut VectorcraftApp, feature: Feature) {
    if app.ai.generate.feature != feature {
        cancel(app);
        forget_result(app);
        let g = &mut app.ai.generate;
        g.feature = feature;
        g.error = None;
        g.note = None;
    }
    app.ai.generate.open = true;
}

fn forget_result(app: &mut VectorcraftApp) {
    if let Some(shown) = app.ai.generate.result.take() {
        app.ai.genai.discard(shown.job);
    }
}

/// Close the window: a running request is stopped and the result forgotten.
pub(crate) fn close(app: &mut VectorcraftApp) {
    cancel(app);
    forget_result(app);
    let g = &mut app.ai.generate;
    g.open = false;
    g.error = None;
    g.note = None;
}

/// Why Generate can't run now (also its tooltip), or `None`.
pub(crate) fn blocked(app: &VectorcraftApp) -> Option<&'static str> {
    let ai = &app.ai;
    let g = &ai.generate;
    if g.job.is_some() {
        return Some(tl!("A request is running. Stop it to start another."));
    }
    let keyed = match g.provider {
        Some(kind) => ai.connected(kind),
        None => ai.has_key(),
    };
    if !keyed {
        return Some(tl!("Add an API key in AI Accounts first."));
    }
    if !ai.consented() {
        return Some(tl!("Agree in AI Accounts that requests go to your AI provider first."));
    }
    if let Some(why) = unsuitable(app, g.feature) {
        return Some(why);
    }
    if g.needs_prompt() && g.prompt.trim().is_empty() {
        return Some(tl!("Describe what to generate."));
    }
    if g.feature == Feature::Rewrite && g.tone == ToneChoice::Custom && g.custom_tone.trim().is_empty() {
        return Some(tl!("Say how to rewrite the text."));
    }
    None
}

/// Generate: send the request the window describes (`ai.panel.generate`).
pub(crate) fn start(app: &mut VectorcraftApp) -> Result<Value, String> {
    if let Some(why) = blocked(app) {
        return Err(why.to_string());
    }
    forget_result(app);
    let request = app.ai.generate.request();
    let provider = app.ai.generate.provider;
    let started = app.ai.genai.start(&mut app.session, &request, provider);
    let g = &mut app.ai.generate;
    g.note = None;
    match started {
        Ok(job) => {
            g.job = Some((job, Instant::now()));
            g.error = None;
            Ok(json!({ "job": job.0, "feature": g.feature.id() }))
        }
        Err(e) => {
            let m = message(&e);
            g.error = Some(e);
            Err(m)
        }
    }
}

/// Stop: the running request is cancelled and whatever it still sends is dropped (`ai.panel.stop`).
pub(crate) fn cancel(app: &mut VectorcraftApp) -> bool {
    let Some((job, _)) = app.ai.generate.job.take() else { return false };
    app.ai.genai.cancel(job);
    app.ai.generate.note = Some(tl!("Stopped. Nothing was placed.").to_string());
    true
}

/// The window's request ended.
pub(crate) fn finished(app: &mut VectorcraftApp, job: JobId, result: nib_genai::Result<Outcome>) {
    app.ai.generate.job = None;
    match result {
        Ok(Outcome::Generated(g)) => {
            let shown = Shown { job, feature: g.feature(), items: thumbs(&g) };
            let n = shown.items.len();
            let panel = &mut app.ai.generate;
            panel.result = Some(shown);
            panel.error = None;
            panel.note =
                Some(crate::i18n::trn(crate::i18n::current(), n as u64, "{n} result. Click it to place it.", "{n} results. Click one to place it."));
        }
        Ok(Outcome::Models(_)) => {}
        Err(e) if e.kind == ErrorKind::Cancelled => {
            app.ai.generate.note = Some(tl!("Stopped. Nothing was placed.").to_string());
        }
        Err(e) => app.ai.generate.error = Some(e),
    }
}

/// Place result `i` of the last request (`ai.panel.place`): one undo step named after the feature.
pub(crate) fn place(app: &mut VectorcraftApp, i: usize) -> Result<Value, String> {
    let Some(shown) = &app.ai.generate.result else { return Err(tl!("There is no result to place yet. Generate first.").to_string()) };
    if i >= shown.items.len() {
        return Err(format!("there is no result {} (there are {})", i + 1, shown.items.len()));
    }
    let job = shown.job;
    let applied = app.ai.genai.apply(&mut app.session, job, i);
    let g = &mut app.ai.generate;
    match applied {
        Ok(a) => {
            g.error = None;
            g.note = Some(crate::i18n::fmt(tl!("Placed result {n}. Edit › Undo takes it back."), &[("n", (i + 1).to_string().as_str())]));
            Ok(serde_json::to_value(&a).unwrap_or(Value::Null))
        }
        Err(e) => {
            let m = message(&e);
            g.error = Some(e);
            Err(m)
        }
    }
}

/// What the window shows of `g`'s variations.
fn thumbs(g: &Generated) -> Vec<Thumb> {
    (0..g.variations())
        .map(|i| match g.preview(i) {
            Some(Preview::Svg(svg)) => svg_image(svg).map_or(Thumb::Blank, |image| Thumb::Image { image, tex: None }),
            Some(Preview::Png(png)) => png_image(png).map_or(Thumb::Blank, |image| Thumb::Image { image, tex: None }),
            Some(Preview::Palette(name, colors)) => Thumb::Palette(name.to_string(), colors.iter().filter_map(|c| hex_color(c)).collect()),
            Some(Preview::Text(t)) => Thumb::Text(t),
            None => Thumb::Blank,
        })
        .collect()
}

/// A sanitized SVG drawn as a thumbnail, through Nib's own importer and renderer.
fn svg_image(svg: &str) -> Option<egui::ColorImage> {
    let doc = vectorcraft_svg::import(svg).ok()?;
    let rect = doc.artboards.first().map(|a| a.rect)?;
    let side = rect.width().max(rect.height());
    if !side.is_finite() || side <= 0.0 {
        return None;
    }
    let scale = f64::from(THUMB_PX) / side;
    let img = vectorcraft_render::Renderer::new().render_region(&doc, rect, scale, true);
    (img.width > 0 && img.height > 0).then(|| crate::canvas::color_image(&img))
}

/// A PNG decoded (with the core's limits) and scaled down to a thumbnail.
fn png_image(png: &[u8]) -> Option<egui::ColorImage> {
    let img = nib_genai::image_util::decode(png).ok()?;
    let (w, h) = (img.width().max(1), img.height().max(1));
    let k = (f64::from(THUMB_PX) / f64::from(w.max(h))).min(1.0);
    let (tw, th) = (((f64::from(w) * k).round() as u32).max(1), ((f64::from(h) * k).round() as u32).max(1));
    let small = image::imageops::thumbnail(&img, tw, th);
    Some(egui::ColorImage::from_rgba_unmultiplied([tw as usize, th as usize], small.as_raw()))
}

fn hex_color(hex: &str) -> Option<egui::Color32> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 || !h.is_ascii() {
        return None;
    }
    let byte = |i: usize| h.get(i..i + 2).and_then(|s| u8::from_str_radix(s, 16).ok());
    Some(egui::Color32::from_rgb(byte(0)?, byte(2)?, byte(4)?))
}

/// What a click in the window asked for, done after it is drawn.
enum Act {
    Generate,
    Stop,
    Place(usize),
    Accounts,
}

/// Draw the window while it is open.
pub(crate) fn show(app: &mut VectorcraftApp, ctx: &egui::Context) {
    if !app.ai.generate.open {
        return;
    }
    let mut open = true;
    let mut act = None;
    egui::Window::new(tl!("Generate"))
        .id(egui::Id::unique("nib-ai-generate"))
        .open(&mut open)
        .collapsible(false)
        .resizable(false)
        .default_pos(ctx.content_rect().right_top() + egui::vec2(-WIDTH - 60.0, 90.0))
        .show(ctx, |ui| {
            ui.set_width(WIDTH);
            act = body(app, ui);
        });
    match act {
        Some(Act::Generate) => {
            let _ = app.run(super::GENERATE, json!({}));
        }
        Some(Act::Stop) => {
            let _ = app.run(super::CANCEL, json!({}));
        }
        Some(Act::Place(i)) => {
            if let Err(e) = app.run(super::PLACE, json!({ "variation": i })) {
                app.status(e);
            }
        }
        Some(Act::Accounts) => super::accounts::open(app),
        None => {}
    }
    if !open {
        close(app);
    }
}

fn body(app: &mut VectorcraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let feature = app.ai.generate.feature;
    ui.label(egui::RichText::new(tl!(feature.label())).font(crate::theme::semibold(15.0)).color(t.text));
    ui.label(egui::RichText::new(works_on(feature)).color(t.text_dim).small());
    ui.add_space(6.0);
    let mut act = account_notice(app, ui);
    prompt_field(app, ui);
    options(app, ui);
    provider_row(app, ui);
    ui.add_space(8.0);
    act = action_row(app, ui).or(act);
    act = error_line(app, ui).or(act);
    if let Some(note) = &app.ai.generate.note {
        ui.label(egui::RichText::new(note.as_str()).color(t.text_dim));
    }
    act = results(app, ui).or(act);
    ui.add_space(4.0);
    ui.label(
        egui::RichText::new(tl!("Your prompt, and what this feature works on, go to your AI provider when you press Generate."))
            .color(t.text_dim)
            .small(),
    );
    act
}

/// What `feature` sends besides the prompt and where its result goes.
fn works_on(feature: Feature) -> &'static str {
    match feature {
        Feature::TextToVector => tl!("Vector art from a description, placed in the selection's area or on the artboard."),
        Feature::ShapeFill => tl!("Art that fills the selected closed path, clipped to it."),
        Feature::Pattern => tl!("A seamless pattern swatch from a description."),
        Feature::Expand => tl!("Grows the selected image; the image is sent to your provider."),
        Feature::Recolor => tl!("New colours for the selected artwork; its colours are sent to your provider."),
        Feature::Rewrite => tl!("The selected type rewritten; its text is sent to your provider."),
    }
}

/// No key or no consent yet: what to do, with a link to AI Accounts.
fn account_notice(app: &VectorcraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let text = if !app.ai.has_key() {
        tl!("No API key is set. Add your OpenAI or Google Gemini key to use the AI commands.")
    } else if !app.ai.consented() {
        tl!("Before the first request, agree in AI Accounts that your prompt and artwork go to your AI provider.")
    } else {
        return None;
    };
    let t = Tokens::get(ui.ctx());
    let mut act = None;
    egui::Frame::new().fill(t.panel_darker).corner_radius(4.0).inner_margin(8.0).show(ui, |ui| {
        ui.label(text);
        if ui.link(tl!("Open AI Accounts…")).clicked() {
            act = Some(Act::Accounts);
        }
    });
    ui.add_space(6.0);
    act
}

fn prompt_field(app: &mut VectorcraftApp, ui: &mut egui::Ui) {
    let g = &mut app.ai.generate;
    let hint = match g.feature {
        Feature::TextToVector => tl!("Describe the art, e.g. a red fox curled up asleep"),
        Feature::ShapeFill => tl!("Describe what fills the shape, e.g. autumn leaves"),
        Feature::Pattern => tl!("Describe the pattern, e.g. lemons on blue tiles"),
        Feature::Expand => tl!("What goes in the new area (optional)"),
        Feature::Recolor => tl!("Describe the colours, e.g. sunset, pastel, forest"),
        Feature::Rewrite => return,
    };
    let label = ui.label(tl!("Prompt"));
    let r = ui
        .add(egui::TextEdit::multiline(&mut g.prompt).desired_rows(3).desired_width(WIDTH).hint_text(hint).char_limit(MAX_PROMPT))
        .labelled_by(label.id);
    let _ = r;
}

fn options(app: &mut VectorcraftApp, ui: &mut egui::Ui) {
    let g = &mut app.ai.generate;
    match g.feature {
        Feature::TextToVector => {
            kind_row(ui, &mut g.kind);
            vector_rows(ui, &mut g.detail, &mut g.method, &mut g.variations);
            ui.checkbox(&mut g.style_reference, tl!("Use the selection as a style reference"))
                .on_hover_text(tl!("A rendering of the selected artwork goes with the request"));
        }
        Feature::ShapeFill => {
            vector_rows(ui, &mut g.detail, &mut g.method, &mut g.variations);
            ui.checkbox(&mut g.use_shape_colors, tl!("Use the shape's colours"));
        }
        Feature::Pattern => {
            vector_rows(ui, &mut g.detail, &mut g.method, &mut g.variations);
            ui.horizontal(|ui| {
                ui.label(tl!("Tile size:"));
                ui.add(egui::DragValue::new(&mut g.tile_size).range(4.0..=4000.0).suffix(" pt"));
            });
            ui.checkbox(&mut g.apply_to_selection, tl!("Fill the selection with the pattern"));
        }
        Feature::Expand => {
            ui.checkbox(&mut g.fill_artboard, tl!("Expand to fill the artboard"));
            ui.add_enabled_ui(!g.fill_artboard, |ui| {
                ui.horizontal(|ui| {
                    ui.label(tl!("Add on each side:"));
                    ui.add(egui::DragValue::new(&mut g.margin).range(1.0..=10_000.0).suffix(" pt"));
                });
            });
        }
        Feature::Recolor => variations_row(ui, &mut g.variations),
        Feature::Rewrite => {
            ui.label(tl!("Tone"));
            ui.horizontal_wrapped(|ui| {
                for tone in ToneChoice::ALL {
                    ui.selectable_value(&mut g.tone, tone, tone.label());
                }
            });
            if g.tone == ToneChoice::Custom {
                let label = ui.label(tl!("Instruction"));
                ui.add(egui::TextEdit::singleline(&mut g.custom_tone).desired_width(WIDTH).hint_text(tl!("e.g. as a haiku")).char_limit(500))
                    .labelled_by(label.id);
            }
            variations_row(ui, &mut g.variations);
        }
    }
}

fn kind_row(ui: &mut egui::Ui, kind: &mut VectorKind) {
    ui.horizontal(|ui| {
        ui.label(tl!("Type:"));
        for (k, label) in [
            (VectorKind::Subject, tl!("Subject")),
            (VectorKind::Scene, tl!("Scene")),
            (VectorKind::Icon, tl!("Icon")),
            (VectorKind::Pattern, tl!("Pattern")),
        ] {
            ui.selectable_value(kind, k, label);
        }
    });
}

fn vector_rows(ui: &mut egui::Ui, detail: &mut Detail, method: &mut VectorMethod, variations: &mut u8) {
    ui.horizontal(|ui| {
        ui.label(tl!("Detail:"));
        for (d, label) in [(Detail::Low, tl!("Low")), (Detail::Medium, tl!("Medium")), (Detail::High, tl!("High"))] {
            ui.selectable_value(detail, d, label);
        }
    });
    ui.horizontal(|ui| {
        ui.label(tl!("Method:"));
        ui.selectable_value(method, VectorMethod::Svg, tl!("Vector")).on_hover_text(tl!("The model draws SVG, imported as paths"));
        ui.selectable_value(method, VectorMethod::ImageTrace, tl!("Image + Trace"))
            .on_hover_text(tl!("The model paints an image, which Image Trace turns into paths"));
    });
    variations_row(ui, variations);
}

fn variations_row(ui: &mut egui::Ui, variations: &mut u8) {
    ui.horizontal(|ui| {
        ui.label(tl!("Variations:"));
        for n in 1..=4u8 {
            ui.selectable_value(variations, n, n.to_string());
        }
    });
}

/// With keys for both providers, which one this request goes to.
fn provider_row(app: &mut VectorcraftApp, ui: &mut egui::Ui) {
    if !ProviderKind::ALL.iter().all(|k| app.ai.connected(*k)) {
        return;
    }
    let chosen = app.ai.generate.provider.or(app.ai.default_provider());
    ui.horizontal(|ui| {
        ui.label(tl!("Provider:"));
        for kind in ProviderKind::ALL {
            if ui.selectable_label(chosen == Some(kind), kind.label()).clicked() {
                app.ai.generate.provider = Some(kind);
            }
        }
    });
}

/// Generate, or Stop with a spinner and the time the request has taken.
fn action_row(app: &VectorcraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let mut act = None;
    ui.horizontal(|ui| {
        if let Some((_, started)) = app.ai.generate.job {
            if widgets::secondary_button(ui, tl!("Stop")).clicked() {
                act = Some(Act::Stop);
            }
            ui.add(egui::Spinner::new().size(14.0).color(t.accent));
            let secs = started.elapsed().as_secs();
            ui.label(crate::i18n::fmt(tl!("Generating… {s} s"), &[("s", secs.to_string().as_str())]));
            return;
        }
        let why = blocked(app);
        let r = widgets::primary_button_enabled(ui, tl!("Generate"), why.is_none());
        if let Some(why) = why {
            let _ = r.on_disabled_hover_text(why);
        } else if r.clicked() {
            act = Some(Act::Generate);
        }
    });
    act
}

/// The last request's error, with what fixes it.
fn error_line(app: &VectorcraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let e = app.ai.generate.error.as_ref()?;
    let mut act = None;
    ui.add_space(4.0);
    ui.label(egui::RichText::new(message(e)).color(ui.visuals().error_fg_color));
    ui.horizontal(|ui| {
        if fixed_in_accounts(e) && ui.link(tl!("Open AI Accounts…")).clicked() {
            act = Some(Act::Accounts);
        }
        if retryable(e) && blocked(app).is_none() && ui.link(tl!("Try Again")).clicked() {
            act = Some(Act::Generate);
        }
    });
    act
}

/// The results: a click places one.
fn results(app: &mut VectorcraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let shown = app.ai.generate.result.as_mut()?;
    let mut act = None;
    let tip = match shown.feature {
        Feature::Recolor | Feature::Rewrite => tl!("Click to apply"),
        _ => tl!("Click to place"),
    };
    ui.add_space(4.0);
    ui.horizontal_wrapped(|ui| {
        for (i, thumb) in shown.items.iter_mut().enumerate() {
            let name = crate::i18n::fmt(tl!("Result {n}"), &[("n", (i + 1).to_string().as_str())]);
            if result_tile(ui, thumb, &name).on_hover_text(tip).clicked() {
                act = Some(Act::Place(i));
            }
        }
    });
    act
}

/// One result, clickable, named `name` for screen readers.
fn result_tile(ui: &mut egui::Ui, thumb: &mut Thumb, name: &str) -> egui::Response {
    let t = Tokens::get(ui.ctx());
    let size = match thumb {
        Thumb::Text(_) => egui::vec2(WIDTH, 0.0),
        Thumb::Palette(..) => egui::vec2(WIDTH / 2.0 - 6.0, 44.0),
        _ => egui::vec2(THUMB_PT, THUMB_PT),
    };
    if let Thumb::Text(text) = thumb {
        let r = ui.add(egui::Button::new(egui::RichText::new(text.as_str())).wrap().min_size(egui::vec2(WIDTH, 0.0)));
        let label = format!("{name}: {text}");
        r.widget_info(|| egui::WidgetInfo::labeled(egui::accesskit::Role::Button, true, &label));
        return r;
    }
    let (rect, r) = ui.allocate_exact_size(size, egui::Sense::click());
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, 4.0, egui::Color32::WHITE);
    match thumb {
        Thumb::Image { image, tex } => {
            let tex = tex.get_or_insert_with(|| ui.ctx().load_texture(format!("nib-ai-{name}"), image.clone(), egui::TextureOptions::LINEAR));
            let s = tex.size_vec2();
            let k = (rect.width() - 8.0) / s.x.max(s.y).max(1.0);
            let r = egui::Rect::from_center_size(rect.center(), s * k);
            painter.image(tex.id(), r, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
        }
        Thumb::Palette(title, colors) => {
            let n = colors.len().max(1) as f32;
            let w = (rect.width() - 8.0) / n;
            for (i, c) in colors.iter().enumerate() {
                let x = rect.left() + 4.0 + w * i as f32;
                painter.rect_filled(egui::Rect::from_min_size(egui::pos2(x, rect.top() + 4.0), egui::vec2(w, 22.0)), 0.0, *c);
            }
            painter.text(
                rect.left_bottom() + egui::vec2(4.0, -4.0),
                egui::Align2::LEFT_BOTTOM,
                title.as_str(),
                egui::FontId::proportional(11.0),
                egui::Color32::BLACK,
            );
        }
        Thumb::Blank | Thumb::Text(_) => {
            painter.text(rect.center(), egui::Align2::CENTER_CENTER, name, egui::FontId::proportional(11.0), egui::Color32::DARK_GRAY);
        }
    }
    let stroke = if r.hovered() { egui::Stroke::new(2.0, t.accent) } else { egui::Stroke::new(1.0, t.border) };
    painter.rect_stroke(rect.shrink(1.0), 4.0, stroke, egui::StrokeKind::Inside);
    r.widget_info(|| egui::WidgetInfo::labeled(egui::accesskit::Role::Button, true, name));
    r
}
