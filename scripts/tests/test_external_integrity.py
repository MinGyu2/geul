"""Sandbox policy regression tests without modifying any third-party sources."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('integrity', Path(__file__).resolve().parents[1] / 'external-integrity.py')
g = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g)


class LauncherTests(unittest.TestCase):
    def test_default_is_unprivileged_bwrap(self):
        with patch.object(g.shutil, 'which', return_value='/bin/bwrap'):
            self.assertEqual(g.sandbox_launcher({'PATH': '/bin'}), (['/bin/bwrap'], []))

    def test_unsupported_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'Unsupported'):
            g.sandbox_launcher({'PATH': os.environ['PATH'], 'GEUL_SANDBOX': 'plain'})

    def test_missing_bwrap_fails_closed(self):
        with patch.object(g.shutil, 'which', return_value=None), self.assertRaisesRegex(RuntimeError, 'unprotected'):
            g.sandbox_launcher({})

    def test_sudo_mode_drops_identity_groups_and_capabilities(self):
        with patch.object(g.shutil, 'which', side_effect=lambda name, **kw: '/usr/bin/' + name), patch.object(g.os, 'getuid', return_value=1001), patch.object(g.os, 'getgid', return_value=1002):
            setup, drop = g.sandbox_launcher({'PATH': '/tools', 'GEUL_SANDBOX': 'sudo-bwrap'})
        self.assertEqual(setup[:4], ['/usr/bin/sudo', '-n', '--', '/usr/bin/bwrap'])
        self.assertNotIn('--unshare-user', setup)
        self.assertIn('--cap-drop', setup)
        self.assertIn('--clear-groups', drop)
        self.assertIn('--bounding-set=-all', drop)
        self.assertIn('--no-new-privs', drop)
        self.assertEqual(drop[drop.index('--reuid') + 1], '1001')
        self.assertEqual(drop[drop.index('--regid') + 1], '1002')

    def test_loader_environment_restored_only_after_privilege_drop(self):
        with patch.object(g.shutil, 'which', side_effect=lambda name, **kw: '/usr/bin/' + name), patch.object(g.os, 'getuid', return_value=1001), patch.object(g.os, 'getgid', return_value=1001):
            setup, drop = g.sandbox_launcher({'GEUL_SANDBOX': 'sudo-bwrap', 'LD_PRELOAD': '/untrusted.so'})
        self.assertNotIn('--setenv', setup)
        self.assertNotIn('/untrusted.so', setup)
        self.assertGreater(drop.index('LD_PRELOAD=/untrusted.so'), drop.index('--'))

    def test_missing_privilege_tools_fails_closed(self):
        with patch.object(g.shutil, 'which', side_effect=lambda name, **kw: '/bin/bwrap' if name == 'bwrap' else None), self.assertRaisesRegex(RuntimeError, 'requires'):
            g.sandbox_launcher({'GEUL_SANDBOX': 'sudo-bwrap'})


class AliasBoundaryTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.folder = tempfile.TemporaryDirectory(dir=g.ROOT / 'target')
        self.root = Path(self.folder.name)
        self.external = self.root / 'external'
        self.metadata = self.root / 'metadata'
        self.output = self.root / 'target/output'
        self.output.mkdir(parents=True)
        self.paths = [
            'external/rhwp/src/lib.rs', 'external/wordcraft/src/lib.rs',
            'external/rhwp/Cargo.toml', 'external/rhwp/Cargo.lock',
            'external/wordcraft/Cargo.toml', 'external/wordcraft/Cargo.lock',
            'metadata/index', 'metadata/config', 'metadata/refs/heads/master',
            'metadata/objects/ab/fixture', 'metadata/logs/HEAD', 'metadata/packed-refs',
            'metadata/modules/external/rhwp/index',
            'metadata/modules/external/wordcraft/objects/cd/fixture',
            'metadata/worktrees/linked/index',
        ]
        for name in self.paths:
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('protected synthetic fixture ' + name)

    def tearDown(self):
        self.folder.cleanup()

    def test_hardlink_aliases_cover_entire_git_and_both_sources(self):
        for name in self.paths:
            with self.subTest(path=name):
                source = self.root / name
                original = source.read_bytes()
                alias = self.output / 'alias'
                os.link(source, alias)
                try:
                    with self.assertRaisesRegex(RuntimeError, 'hardlink'):
                        g.audit_aliases([self.output], [self.external, self.metadata])
                    self.assertEqual(source.read_bytes(), original)
                finally:
                    alias.unlink()

    def test_writable_symlinks_into_git_are_rejected(self):
        for target in [self.metadata, self.metadata / 'refs', self.metadata / 'objects/ab/fixture']:
            with self.subTest(target=target):
                alias = self.output / 'alias'
                alias.symlink_to(target)
                try:
                    with self.assertRaisesRegex(RuntimeError, 'symlink'):
                        g.audit_aliases([self.output], [self.external, self.metadata])
                finally:
                    alias.unlink()

    def test_source_link_to_future_cargo_bookkeeping_is_rejected(self):
        cache = self.root / 'cargo-cache'
        cache.mkdir()
        target = cache / 'not-created-yet'
        (self.external / 'future-cache-link').symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'source link'):
            g.audit_aliases([self.output], [self.external, self.metadata], creation_roots=[cache])
        self.assertFalse(target.exists())

    def test_normal_output_and_nonexistent_descendant_need_no_hashing(self):
        (self.output / 'normal').write_text('writable')
        with patch.object(g, 'sha', side_effect=AssertionError('content hashing forbidden')):
            report = g.audit_aliases([self.output, self.root / 'target/future/deep'], [self.external, self.metadata])
        self.assertEqual(report['contentBytesHashed'], 0)
        self.assertGreater(report['metadataEntries'], len(self.paths))
        self.assertFalse((self.root / 'target/future').exists())

    def test_uninspectable_or_missing_protected_path_fails_closed(self):
        original = os.scandir
        def scan(path):
            if path == self.metadata:
                raise PermissionError('synthetic unreadable Git metadata')
            return original(path)
        with patch.object(g.os, 'scandir', side_effect=scan), self.assertRaises(PermissionError):
            g.audit_aliases([self.output], [self.metadata])
        with self.assertRaisesRegex(RuntimeError, 'Missing protected'):
            g.audit_aliases([self.output], [self.root / 'missing-metadata'])

    def test_common_and_worktree_directories_resolved_without_literal_dot_git(self):
        linked = self.metadata / 'worktrees/linked'
        def git(repo, *args):
            if args == ('rev-parse', '--absolute-git-dir'):
                return str(linked).encode()
            if args == ('rev-parse', '--path-format=absolute', '--git-common-dir'):
                return str(self.metadata).encode()
            raise AssertionError(args)
        with patch.object(g, 'git', side_effect=git):
            self.assertEqual(g.git_directories(), [linked, self.metadata])
            self.assertEqual(g.git_metadata_roots({}), [self.metadata])

    def test_git_alternate_object_store_is_protected(self):
        alternate = self.root / 'shared-objects'
        alternate.mkdir()
        info = self.metadata / 'objects/info'
        info.mkdir()
        (info / 'alternates').write_text(str(alternate) + '\n')
        with patch.object(g, 'git_directories', return_value=[self.metadata]):
            self.assertIn(alternate, g.git_metadata_roots({}))
        (info / 'alternates').write_text(str(self.root / 'missing-objects') + '\n')
        with patch.object(g, 'git_directories', return_value=[self.metadata]), self.assertRaises(FileNotFoundError):
            g.git_metadata_roots({})

    def test_uninitialized_submodule_alternates_are_in_preflight_boundary(self):
        objects = self.metadata / 'modules/external/absent/objects'
        (objects / 'info').mkdir(parents=True)
        alternate = self.root / 'shared-absent-objects'
        alternate.mkdir()
        (objects / 'info/alternates').write_text(str(alternate) + '\n')
        with patch.object(g, 'git_directories', return_value=[self.metadata]):
            self.assertIn(alternate, g.git_metadata_roots({}))

    def test_path_traversal_and_overlapping_writable_mounts_rejected(self):
        with patch.object(g, 'ROOT', self.root), patch.object(g, 'git_directories', return_value=[self.metadata]):
            with self.assertRaisesRegex(RuntimeError, 'Unsafe writable'):
                g.artifact_paths([self.root / 'target/../external/new'])
            with self.assertRaisesRegex(RuntimeError, 'Overlapping'):
                g.artifact_paths([self.output, self.output / 'child'])

    def test_actual_bind_mount_alias_rejected_before_mkdir(self):
        import subprocess
        import sys
        mount = self.root / 'target/mount'
        mount.mkdir()
        script = """import importlib.util,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
g.ROOT=Path(sys.argv[2]);g.git_directories=lambda:[g.ROOT/'metadata']
try:g.artifact_paths([g.ROOT/'target/mount/not-created/child'])
except RuntimeError as e:
 assert 'Writable mount aliases' in str(e),str(e)
else:raise AssertionError('bind alias was accepted')
assert not (g.ROOT/'external/not-created').exists()
"""
        result = subprocess.run(['bwrap', '--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/',
                                 '--bind', str(self.external), str(mount), '--', sys.executable, '-c', script,
                                 str(Path(g.__file__)), str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.external / 'not-created').exists())


if __name__ == '__main__':
    unittest.main()
