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



class SandboxTemporaryDirectoryTests(unittest.TestCase):
    """CI run 41014936234: collect2 aborted with "Cannot create temporary file in ./"."""

    def test_private_tmpfs_is_sticky_world_writable(self):
        base = g.sandbox_base(['/bin/bwrap'], network=False)
        index = base.index('--tmpfs')
        self.assertEqual(base[index - 2:index + 2], ['--perms', '1777', '--tmpfs', '/tmp'])
        self.assertIn('--unshare-net', base)
        self.assertNotIn('--unshare-net', g.sandbox_base(['/bin/bwrap'], network=True))

    def test_inherited_temporary_paths_are_replaced_before_launcher(self):
        seen = {}

        def launcher(env):
            seen.update(env)
            raise RuntimeError('stop after launcher')
        inherited = {'TMPDIR': '/host/missing', 'TMP': '/host/ro', 'TEMP': '/x', 'TEMPDIR': '/y', 'PATH': os.environ['PATH']}
        with patch.object(g, 'sandbox_launcher', side_effect=launcher), self.assertRaisesRegex(RuntimeError, 'stop'):
            g.run_readonly([['true']], [], g.ROOT / 'target/unused.json', env=inherited)
        self.assertEqual({name: seen[name] for name in g.TEMP_VARIABLES}, dict.fromkeys(g.TEMP_VARIABLES, '/tmp'))
        self.assertEqual(inherited['TMPDIR'], '/host/missing')

    def test_stale_proof_from_earlier_run_is_not_reused(self):
        import tempfile
        with tempfile.TemporaryDirectory(dir=g.ROOT / 'target') as folder:
            report = Path(folder) / 'r.json'
            stale = report.with_name('r.sandbox-0.json')
            stale.write_text('{"stale": true}')
            import subprocess
            real_run = subprocess.run

            def run(command, *args, **kwargs):
                if command[:1] == ['bwrap']:
                    return subprocess.CompletedProcess(command, 1)
                return real_run(command, *args, **kwargs)
            with patch.object(g, 'sandbox_launcher', return_value=(['bwrap'], [])), \
                    patch.object(g, 'snapshot', return_value={'dependencies': {}}), \
                    patch.object(g, 'git_metadata_roots', return_value=[]), \
                    patch.object(g, 'audit_aliases', return_value={}), \
                    patch.object(g, 'reject_mount_aliases'), \
                    patch.object(g.subprocess, 'run', side_effect=run), \
                    patch.dict(g.os.environ, {'CARGO_HOME': str(Path(folder) / 'no-cargo-home')}), \
                    self.assertRaisesRegex(RuntimeError, 'Protected command'):
                g.run_readonly([['true']], [Path(folder)], report)
            self.assertFalse(stale.exists())
            self.assertEqual(__import__('json').loads(report.read_text())['sandboxProofs'], [])

    def run_in_sandbox(self, perms, script, *args, writable=()):
        import subprocess
        import sys
        base = g.sandbox_base(['bwrap', '--unshare-user'], network=False)
        if perms != '1777':
            base[base.index('--perms') + 1] = perms
        for path in writable:
            base += ['--bind', str(path), str(path)]
        env = {**os.environ, **dict.fromkeys(g.TEMP_VARIABLES, '/tmp')}
        return subprocess.run([*base, '--chdir', str(g.ROOT), '--', sys.executable, '-c', script, *args],
                              cwd=g.ROOT, env=env, capture_output=True, text=True)

    def test_proof_requires_build_identity_writable_tmp(self):
        script = """import importlib.util,json,sys
s=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
gd=g.git(g.ROOT,'rev-parse','--absolute-git-dir').decode().strip()
print(json.dumps(g.verify_sandbox({'readOnly':[str(g.ROOT),str(g.ROOT/'external'),gd],'writable':[],'probes':[]})))
"""
        ok = self.run_in_sandbox('1777', script, str(Path(g.__file__)))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(__import__('json').loads(ok.stdout)['temporaryDirectory'], {'path': '/tmp', 'writable': True})
        # 0555 reproduces the root-owned 0755 tmpfs seen by the unprivileged CI build UID.
        denied = self.run_in_sandbox('0555', script, str(Path(g.__file__)))
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn('not writable by the build identity', denied.stderr)

    def test_rustc_link_under_read_only_cwd(self):
        import shutil
        import tempfile
        if not shutil.which('rustc'):
            self.skipTest('rustc unavailable')
        with tempfile.TemporaryDirectory(dir=g.ROOT / 'target') as folder:
            out = Path(folder)
            (out / 'main.rs').write_text('fn main() {}\n')
            script = """import subprocess,sys
r=subprocess.run(['rustc',sys.argv[1],'-o',sys.argv[2]],capture_output=True,text=True)
sys.stderr.write(r.stderr);sys.exit(r.returncode)
"""
            failed = self.run_in_sandbox('0555', script, str(out / 'main.rs'), str(out / 'old'), writable=[out])
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('Cannot create temporary file in ./: Read-only file system', failed.stderr)
            linked = self.run_in_sandbox('1777', script, str(out / 'main.rs'), str(out / 'new'), writable=[out])
            self.assertEqual(linked.returncode, 0, linked.stderr)
            self.assertTrue((out / 'new').is_file())


if __name__ == '__main__':
    unittest.main()
