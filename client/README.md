# client/

Rust workspace for the browser app's WebAssembly module (`flats-racer-web`, built from
`flats-racer-physics` and the `benilla-*` WoW-format parsers). Everything else that used to live
here (the native Bevy client) was removed; last commit containing it: `3b4f139e`.

```
cargo test --release -j 2 -p flats-racer-physics -p flats-racer-web
```

See [../README.md](../README.md) and [../browser/README.md](../browser/README.md).
