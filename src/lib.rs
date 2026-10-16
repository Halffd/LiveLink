//! Shared library for the LiveLink binaries.

pub mod api;
pub mod cli;
pub mod config;
pub mod core;
pub mod player_ui;
pub mod queue;
pub mod services;
pub mod ui;

#[cfg(test)]
mod core_test;
