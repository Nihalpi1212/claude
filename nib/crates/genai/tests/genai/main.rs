//! The genai test suite, one binary (every test binary links the whole engine). No test reaches a
//! real provider: they talk to a mock HTTP server on 127.0.0.1.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

mod common;
mod keys;
mod ops;
mod providers;
mod sanitize;
mod units;
