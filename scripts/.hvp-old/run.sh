set -u
echo "== with the fix"
python3 -I scripts/cmux-next/tests/test_hot_verify.py 2>&1 | tail -4; a=${PIPESTATUS[0]}
python3 -I tests/test_side_instance_remake_clears_old_identity.py 2>&1 | tail -4; b=${PIPESTATUS[0]}
command -v zsh || echo "no zsh on this runner"
echo "== without the fix (the old engine and side-instance.sh)"
cp scripts/.hvp-old/hot-verify.py scripts/cmux-next/hot-verify.py
cp scripts/.hvp-old/side-instance.sh scripts/cmux-next/side-instance.sh
python3 -I scripts/cmux-next/tests/test_hot_verify.py VideoTest 2>&1 | grep -E "^(FAIL|ERROR):|^Ran|^FAILED|^OK"
python3 -I tests/test_side_instance_remake_clears_old_identity.py 2>&1 | grep -E "^(FAIL|ERROR):|^Ran|^FAILED|^OK"
echo "with-fix exits: $a $b"
[ "$a" = 0 ] && [ "$b" = 0 ]
