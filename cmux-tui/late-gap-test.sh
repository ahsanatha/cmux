#!/bin/bash
set -e
cd cmux-tui
cargo test -p cmux-rd-core --test media a_gap_exposed_after 2>&1 | tail -30
