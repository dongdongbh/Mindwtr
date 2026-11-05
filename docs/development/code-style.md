# Self-explanatory code

Use precise names, focused functions, explicit types, and straightforward control flow instead of explanatory comments, doc comments, docstrings, or commented-out code. If code needs an explanation to be understood, improve the code. Keep architectural history in engineering documentation and behavior guarantees in tests.

CI checks owned source with language parsers, so comment markers in strings, URLs, regular expressions, and templates remain data. Required license notices, compiler/typechecker/linter/test annotations, shebangs, and other functional directives remain allowed. Vendored code, generated Gradle wrappers, dependency patches, and external XML fixtures are outside the owned-source check.

Run the check locally with a disk-backed virtual environment:

```sh
python3 -m venv .venv-comments
.venv-comments/bin/python -m pip install -r scripts/ci/comments-requirements.txt
.venv-comments/bin/python -m unittest discover -s scripts/ci -p test_check_comments.py
.venv-comments/bin/python scripts/ci/check_comments.py
```

The first run downloads pinned language parsers to the normal user cache. To check a smaller scope, pass source file paths to `check_comments.py`.
