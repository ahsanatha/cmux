set -u
echo "== with the fix"
python3 -I scripts/cmux-next/tests/test_hot_verify.py 2>&1 | tail -3; a=${PIPESTATUS[0]}
echo "== without the fix"
cp scripts/.hvp-old/hot-verify.py scripts/cmux-next/hot-verify.py
python3 -I scripts/cmux-next/tests/test_hot_verify.py VideoTest 2>&1 | grep -E "^(FAIL|ERROR):|^Ran|^FAILED|^OK"
echo "with-fix exit: $a"; [ "$a" = 0 ]
