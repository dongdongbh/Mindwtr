import argparse
import ast
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import yaml
from tree_sitter_language_pack import get_parser

SOURCE_LANGUAGES = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".rs": "rust",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".py": "python",
    ".sh": "bash",
    ".bash": "bash",
    ".c": "c",
    ".h": "c",
    ".m": "objc",
    ".mm": "objc",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".css": "css",
    ".rb": "ruby",
    ".podspec": "ruby",
    ".gradle": "groovy",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".html": "html",
    ".xml": "xml",
    ".json": "json",
    ".sql": "sql",
    ".ps1": "powershell",
    ".java": "java",
    ".plist": "xml",
    ".entitlements": "xml",
    ".xcprivacy": "xml",
    ".properties": "properties",
    ".desktop": "ini",
}
SOURCE_FILENAMES = {
    "Gemfile": "ruby",
    "Fastfile": "ruby",
    "Appfile": "ruby",
    "Matchfile": "ruby",
    "Podfile": "ruby",
    "Dockerfile": "dockerfile",
    "PKGBUILD": "bash",
    "PKGBUILD-beta-bin.template": "bash",
    "chocolateyInstall.ps1.template": "powershell",
    "mindwtr.desktop.template": "ini",
    "nginx.conf": "nginx",
    ".env.example": "bash",
    ".env.https.example": "bash",
}
COMMENT_NODE_TYPES = {
    "comment",
    "line_comment",
    "block_comment",
    "multiline_comment",
    "documentation_comment",
    "js_comment",
    "marginalia",
    "Comment",
}
LEGAL_NOTICE = re.compile(
    rb"copyright\s*(?:\(c\)|[0-9])|SPDX-License-Identifier|licensed under|"
    rb"permission is hereby granted|all rights reserved|Lucide.*license|"
    rb"Ionicons.*license",
    re.I | re.S,
)
FUNCTIONAL_DIRECTIVE = re.compile(
    rb"^\s*(?://+|/\*+|\#)\s*(?:<reference\b|"
    rb"@(?:ts-|vitest-|jest-|jsx\b|jsxImportSource\b|jsxRuntime\b|flow\b|"
    rb"noflow\b|vite-ignore\b|preserve\b|license\b)|"
    rb"eslint(?:-disable|-enable|-env)\b|globals?\s+[\w$]+\s*:|jshint\b|"
    rb"prettier-ignore\b|swift-tools-version:|swiftlint:|swiftformat:|"
    rb"shellcheck\b|type:\s*ignore|noqa\b|pragma:\s*no\s*cover|"
    rb"(?:c8|istanbul|v8)\s+ignore\b|sourceMappingURL=|sourceURL=|"
    rb"encoding[:=]|coding[:=]|[#!@]__PURE__|webpack[A-Z])"
)
HTML_EMBEDDED_LANGUAGES = {
    "script_element": "javascript",
    "style_element": "css",
}


def is_comment(node):
    return node.type in COMMENT_NODE_TYPES


def source_language(path):
    if (
        ("/__fixtures__/" in path and path.endswith(".xml"))
        or path.endswith(("gradlew", "gradlew.bat", ".lock", ".patch"))
        or any(
            part in path.split("/")
            for part in ("CMindwtrArgon2", "vendor", "third_party", "third-party")
        )
    ):
        return None
    source = Path(path)
    return SOURCE_LANGUAGES.get(source.suffix) or SOURCE_FILENAMES.get(source.name)


def permitted_comment(text):
    normalized = re.sub(rb"(?m)^\s*\* ?", b"", text)
    return bool(
        LEGAL_NOTICE.search(text)
        or FUNCTIONAL_DIRECTIVE.search(normalized)
        or text.startswith((b"#!", b"// !$*UTF8*$!"))
    )


def explanatory_comments(parser, data):
    tree = parser.parse(data)
    pending = [tree.root_node]
    found = []
    while pending:
        node = pending.pop()
        if is_comment(node):
            if not permitted_comment(data[node.start_byte:node.end_byte]):
                found.append((node.start_point.row + 1, node.start_point.column + 1))
        elif (
            node.type == "raw_text"
            and node.parent.type in HTML_EMBEDDED_LANGUAGES
        ):
            language = HTML_EMBEDDED_LANGUAGES[node.parent.type]
            body = data[node.start_byte:node.end_byte]
            for line, column in explanatory_comments(get_parser(language), body):
                found.append(
                    (
                        node.start_point.row + line,
                        column + (node.start_point.column if line == 1 else 0),
                    )
                )
        else:
            pending.extend(reversed(node.children))
    return found


def python_docstrings(data):
    tree = ast.parse(data)
    found = []
    for node in ast.walk(tree):
        if (
            isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and node.body
        ):
            first = node.body[0]
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                found.append((first.lineno, first.col_offset + 1))
    return found


def yaml_scalar_location(source, scalar, body, line, column):
    source_lines = source.splitlines()
    body_line = body.splitlines()[line - 1]
    if scalar.style == "|":
        source_row = scalar.start_mark.line + line
        source_line = source_lines[source_row].encode()
        return source_row + 1, len(source_line) - len(body_line) + column
    scalar_source = source[scalar.start_mark.index:scalar.end_mark.index].encode()
    body_offset = scalar_source.find(body)
    if body_offset >= 0:
        prefix = b"\n".join(body.splitlines()[:line - 1])
        offset = body_offset + len(prefix) + (1 if line > 1 else 0) + column - 1
    else:
        fragment = body_line[column - 1:]
        if not fragment or scalar_source.count(fragment) != 1:
            return scalar.start_mark.line + 1, scalar.start_mark.column + 1
        offset = scalar_source.index(fragment)
    source_prefix = source[:scalar.start_mark.index].encode() + scalar_source[:offset]
    return source_prefix.count(b"\n") + 1, len(source_prefix.rsplit(b"\n", 1)[-1]) + 1


def workflow_shell_comments(data, yaml_parser):
    source = data.decode()
    pending = [yaml.compose(source, Loader=yaml.SafeLoader)]
    seen = set()
    found = []
    while pending:
        node = pending.pop()
        if node is None or id(node) in seen:
            continue
        seen.add(id(node))
        if isinstance(node, yaml.SequenceNode):
            pending.extend(reversed(node.value))
        if not isinstance(node, yaml.MappingNode):
            continue
        pending.extend(value for _, value in reversed(node.value))
        fields = {
            key.value: value
            for key, value in node.value
            if isinstance(key, yaml.ScalarNode)
        }
        scalar = fields.get("run")
        if not isinstance(scalar, yaml.ScalarNode) or scalar.tag != "tag:yaml.org,2002:str":
            continue
        shell_node = fields.get("shell")
        shell_name = shell_node.value if isinstance(shell_node, yaml.ScalarNode) else "bash"
        shell = "bash"
        if shell_name.startswith(("pwsh", "powershell")):
            shell = "powershell"
        elif shell_name.startswith("python"):
            shell = "python"
        body = scalar.value
        if shell == "python":
            body = textwrap.dedent(body)
        body = body.encode()
        comments = explanatory_comments(get_parser(shell), body)
        if shell == "python":
            comments.extend(python_docstrings(body))
        for line, column in sorted(comments):
            found.append(yaml_scalar_location(source, scalar, body, line, column))
    return found


def main():
    arguments = argparse.ArgumentParser(
        description=(
            "Reject explanatory comments in owned source; "
            "allow legal notices and functional directives."
        )
    )
    arguments.add_argument("paths", nargs="*")
    options = arguments.parse_args()
    root = Path(__file__).resolve().parents[2]
    paths = options.paths or subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=root
    ).decode().split("\0")[:-1]
    parsers = {}
    violations = []
    checked = 0
    for name in paths:
        language = source_language(name)
        path = root / name
        if language is None or not path.is_file():
            continue
        if language not in parsers:
            parsers[language] = get_parser(language)
        checked += 1
        data = path.read_bytes()
        if path.name == "mindwtr.desktop.template":
            data = re.sub(rb"\{\{[^{}\r\n]*\}\}", lambda expression: b" " * len(expression[0]), data)
        comments = explanatory_comments(parsers[language], data)
        if language == "yaml" and (name.startswith(".github/") or Path(name).name in ("action.yml", "action.yaml")):
            comments.extend(workflow_shell_comments(data, parsers[language]))
        if language == "python":
            comments.extend(python_docstrings(data))
        for line, column in comments:
            violations.append(
                f"{name}:{line}:{column}: replace the explanatory comment "
                "with clear code or an explicit behavioral test"
            )
    if violations:
        print("\n".join(violations[:100]))
    print(f"No-comments policy: {checked} source files checked, {len(violations)} violations.")
    if len(violations) > 100:
        print(
            f"{len(violations) - 100} additional violations omitted; "
            "pass paths to narrow the check."
        )
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
