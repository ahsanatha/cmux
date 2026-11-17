set -u
cd cmux-tui
echo "=== HEAD window-rules"; cargo test -p cmux-window-rules 2>&1 | grep -E "test result|FAILED|panicked|remote" 
echo "=== HEAD catalog"; cargo test -p cmux-action-catalog 2>&1 | grep -E "test result|FAILED|panicked"
echo "=== HEAD contract"; cargo test -p cmux-tui --lib action_argument_contract 2>&1 | grep -vE "^\s+(Compiling|Running|Finished)|^warning" | grep -E -A25 "^---- |test result" | head -120
cd ..
git fetch -q --depth=1 origin 8b34d017bf384255e2addf06660fb4c7e8c688e0 2>/dev/null || echo "fetch base failed"
git checkout 8b34d017bf384255e2addf06660fb4c7e8c688e0 -- cmux-tui plans Packages scripts && echo "=== on BASE"
cd cmux-tui
echo "=== BASE catalog"; cargo test -p cmux-action-catalog 2>&1 | grep -E "test result|FAILED"
echo "=== BASE contract"; cargo test -p cmux-tui --lib action_argument_contract 2>&1 | grep -E "test result|FAILED|^    cli::"
