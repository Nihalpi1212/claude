//! The pigment-genai test suite, one binary (every test binary links the whole engine). No test
//! reaches a real provider: they talk to a mock HTTP server on 127.0.0.1.
#![cfg(not(target_arch = "wasm32"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

mod backend;
mod chat;
mod chatgpt;
mod common;
mod keys;
mod providers;
