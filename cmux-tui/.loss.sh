#!/bin/bash
set -u
cd cmux-tui
echo "== GREEN (fix)"
cargo test -p cmux-rd-engine --test engine a_shard_repaired 2>&1 | grep -E "^test |test result|panicked|repaired loss|^error" | head
st=0
cargo test -p cmux-rd-core -p cmux-rd-engine > /tmp/t1.log 2>&1 || { st=1; echo T1; grep -E "FAILED|panicked|left:|right:|^error" -A3 /tmp/t1.log | head -40; }
cargo test --manifest-path crates/cmux-app-ffi/Cargo.toml -p cmux-rd-ffi > /tmp/t2.log 2>&1 || { st=1; echo T2; grep -E "FAILED|panicked|left:|right:|^error" -A3 /tmp/t2.log | head -40; }
cargo clippy -p cmux-rd-core -p cmux-rd-engine --all-targets -- -D warnings > /tmp/c1.log 2>&1 || { st=1; echo C1; tail -30 /tmp/c1.log; }
echo SUITES_STATUS=$st
cd ..
git fetch -q --deepen=2 origin || echo DEEPEN_FAILED
git checkout -q HEAD~1 -- cmux-tui/crates/cmux-rd-core/src/loss.rs cmux-tui/crates/cmux-rd-engine/src/lib.rs || echo CHECKOUT_FAILED
cd cmux-tui
echo "== RED (tests only, $(git log -1 --format=%h HEAD~1))"
cargo test -p cmux-rd-engine --test engine a_shard_repaired 2>&1 | grep -E "^test |test result|panicked|repaired loss|^error" | head
exit $st
