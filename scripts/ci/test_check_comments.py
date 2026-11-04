import unittest
import subprocess
import sys
import tempfile
from pathlib import Path

from tree_sitter_language_pack import get_parser
from check_comments import (
    explanatory_comments,
    permitted_comment,
    python_docstrings,
    source_language,
    workflow_shell_comments,
)


class CommentPolicyTests(unittest.TestCase):
    def test_desktop_template_directives_are_not_explanatory_comments(self):
        source = '[Desktop Entry]\n{{#if comment}}\nComment={{comment}}\n{{/if}}\nName={{name}}\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'mindwtr.desktop.template'
            command = [sys.executable, str(Path(__file__).with_name('check_comments.py')), str(path)]
            path.write_text(source)
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            path.write_text('# explanation\n' + source + '# another explanation\n')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn(f'{path}:1:1:', result.stdout)
            self.assertIn(f'{path}:7:1:', result.stdout)
            self.assertIn('2 violations.', result.stdout)

    def test_explanations_are_rejected_across_source_languages(self):
        samples = {
            'typescript': b'const value = 1; // explanation',
            'tsx': b'const view = <div>{/* explanation */}</div>;',
            'swift': b'let value = 1 // explanation',
            'kotlin': b'val value = 1 /* outer /* nested */ explanation */',
            'rust': b'//! explanation\nfn main() {}',
            'python': b'value = 1 # explanation',
            'bash': b'echo value # explanation',
            'ruby': b'value = 1 # explanation',
            'cpp': b'int value = 1; // explanation',
            'css': b'/* explanation */ .item { color: red; }',
            'xml': b'<root><!-- explanation --></root>',
            'yaml': b'value: 1 # explanation',
            'toml': b'value = 1 # explanation',
            'sql': b'-- explanation\nSELECT 1;',
            'powershell': b'$value = 1 # explanation',
        }
        for language, sample in samples.items():
            with self.subTest(language=language):
                self.assertEqual(len(explanatory_comments(get_parser(language), sample)), 1)

    def test_strings_regexes_and_templates_are_not_comments(self):
        samples = {
            'typescript': (
                br'const url = "https://example.com"; const regex = /\/\//; '
                br'const text = `/* data */ ${"// data"}`;'
            ),
            'swift': b'let text = #"// data /* data */"#',
            'kotlin': b'val text = """// data /* data */"""',
            'rust': b'let text = r#"// data /* data */"#;',
            'bash': b'echo "# data"',
            'python': b'text = "# data"',
            'yaml': b'text: "# data"\nscript: |\n  # literal data\n',
        }
        for language, sample in samples.items():
            with self.subTest(language=language):
                self.assertEqual(explanatory_comments(get_parser(language), sample), [])

    def test_only_functional_and_legal_metadata_are_permitted(self):
        for text in [
            b'/**\n * @vitest-environment jsdom\n */',
            b'// @ts-expect-error deliberate invalid input',
            b'// eslint-disable-next-line no-console',
            b'/// <reference types="vitest" />',
            b'// swift-tools-version: 5.9',
            b'#!/usr/bin/env bash',
            b'# shellcheck disable=SC2086',
            b'/* Copyright (c) 2026 Example */',
        ]:
            self.assertTrue(permitted_comment(text), text)
        for text in [
            b'// eslint-plugin-import cannot follow this shape',
            b'// global path lookup',
            b'//! module explanation',
            b'// This looks like @ts-ignore but is prose',
        ]:
            self.assertFalse(permitted_comment(text), text)

    def test_workflow_shell_comments_are_checked_without_treating_literals_as_code(self):
        data = (
            b'jobs:\n  test:\n    steps:\n      - run: |\n'
            b'          echo "# data"\n          # explanation\n          echo done\n'
        )
        self.assertEqual(workflow_shell_comments(data, get_parser('yaml')), [(6, 11)])

    def test_quoted_and_plain_workflow_commands_are_decoded_as_shell(self):
        samples = [
            b"run: 'echo value # explanation'\n",
            b'run: "echo value # explanation"\n',
            b'run: echo value;# explanation\n',
        ]
        for data in samples:
            with self.subTest(data=data):
                self.assertEqual(
                    workflow_shell_comments(data, get_parser('yaml')),
                    [(1, data.index(b'#') + 1)],
                )
        self.assertEqual(
            workflow_shell_comments(
                b'run: "echo \\"# data\\""\n', get_parser('yaml')
            ),
            [],
        )

    def test_yaml_folding_and_escapes_cannot_hide_shell_comments(self):
        cases = [
            (b'run: >-\n  echo value\n  # explanation\n', [(3, 3)]),
            (b'run: "echo value \\x23 explanation"\n', [(1, 6)]),
            (b'run: "echo value\\n# explanation"\n', [(1, 19)]),
        ]
        for data, locations in cases:
            with self.subTest(data=data):
                self.assertEqual(
                    workflow_shell_comments(data, get_parser('yaml')), locations
                )

    def test_workflow_data_and_shell_quoted_hashes_remain_literals(self):
        data = (
            b'description: "# explanation"\n'
            b'run: true\n'
            b'steps:\n'
            b'  - run: \'echo "# literal"\'\n'
            b'  - shell: "pwsh"\n'
            b'    run: \'Write-Output "# literal"\'\n'
        )
        self.assertEqual(workflow_shell_comments(data, get_parser('yaml')), [])
        data = b'shell: "pwsh"\nrun: \'Write-Output value # explanation\'\n'
        self.assertEqual(
            workflow_shell_comments(data, get_parser('yaml')), [(2, 26)]
        )

    def test_yaml_alias_cycles_do_not_repeat_or_hang_shell_checks(self):
        data = b'workflow: &workflow\n  run: \'echo value # explanation\'\n  nested: *workflow\n'
        self.assertEqual(
            workflow_shell_comments(data, get_parser('yaml')), [(2, 20)]
        )

    def test_python_workflow_docstrings_keep_yaml_source_locations(self):
        data = (
            b"shell: 'python'\n"
            b'run: |\n'
            b'  """module explanation"""\n'
            b'  def run():\n'
            b'      """function explanation"""\n'
            b'      return "# runtime data"\n'
        )
        self.assertEqual(
            workflow_shell_comments(data, get_parser('yaml')), [(3, 3), (5, 7)]
        )

    def test_html_embedded_source_comments_keep_html_source_locations(self):
        data = (
            b'<script>const url = "https://example.com"; // explanation\n'
            b'const text = "/* data */";\n'
            b'</script><style>\n'
            b'.item { color: red; } /* explanation */\n'
            b'</style>'
        )
        self.assertEqual(
            explanatory_comments(get_parser('html'), data),
            [(1, data.index(b'// explanation') + 1), (4, 23)],
        )

    def test_quoted_python_runs_check_docstrings_and_keep_runtime_strings(self):
        self.assertEqual(
            workflow_shell_comments(
                b'shell: python\nrun: \'"""explanation"""\'\n', get_parser('yaml')
            ),
            [(2, 7)],
        )
        self.assertEqual(
            workflow_shell_comments(
                b'shell: python\nrun: |\n  HELP = """runtime help"""\n',
                get_parser('yaml'),
            ),
            [],
        )

    def test_html_embedded_strings_and_metadata_are_preserved(self):
        data = (
            b'<script>const text = "// data"; const regex = /\\/\\//;\n'
            b'// @ts-expect-error invalid fixture\n'
            b'</script><style>/* Copyright (c) 2026 Example */\n'
            b'.item::after { content: "/* data */"; }</style>'
        )
        self.assertEqual(explanatory_comments(get_parser('html'), data), [])

    def test_docstrings_are_rejected_but_runtime_help_text_is_allowed(self):
        self.assertEqual(
            python_docstrings(
                b'"""explanation"""\ndef run():\n    """explanation"""\n    return 1\n'
            ),
            [(1, 1), (3, 5)],
        )
        self.assertEqual(python_docstrings(b'COMMAND_DESCRIPTION = """runtime help text"""\n'), [])

    def test_owned_sources_are_checked_and_vendored_or_data_files_are_excluded(self):
        self.assertEqual(source_language('packages/core/src/task.ts'), 'typescript')
        self.assertEqual(source_language('aur/PKGBUILD'), 'bash')
        for name in ['.env.example', '.env.https.example']:
            self.assertEqual(source_language(name), 'bash')
        for name in ['settings.plist', 'App.entitlements', 'Privacy.xcprivacy']:
            self.assertEqual(source_language(name), 'xml')
        for name, language in {
            'Widget.java': 'java',
            'gradle.properties': 'properties',
            'mindwtr.desktop': 'ini',
            'nginx.conf': 'nginx',
            'mindwtr.desktop.template': 'ini',
            'PKGBUILD-beta-bin.template': 'bash',
            'chocolateyInstall.ps1.template': 'powershell',
        }.items():
            self.assertEqual(source_language(name), language)
        for path in [
            'apps/ios-native/Sources/CMindwtrArgon2/include/argon2.h',
            'apps/android-native/android/gradlew',
            'apps/mobile/shims/__fixtures__/response.xml',
            'patches/dependency.patch',
            'README.md',
        ]:
            self.assertIsNone(source_language(path), path)


if __name__ == '__main__':
    unittest.main()
