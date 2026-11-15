// camera-raw-panels' develop stages (ARCHITECTURE.md "0.5 features", S8.1, package 8). Skeleton stub: it registers
// nothing, so develop() runs 0.4's builtin stages only. develop.js imports this file before it registers the
// builtins, so a stage registered here with a builtin's id (treatment, hsl, …) replaces the builtin. Import rule: this
// file and its imports import develop-stages.js and develop-util.js, never develop.js. The package replaces this file
// at the same path.
export {};
