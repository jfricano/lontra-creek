import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stage = Path(self.tmp.name)
        self.data = json.dumps(dict(format=1, epoch='2026-01-01T00:00:00.000Z', tickMs=2000,
                                   world=dict(tick=20, generation=1))).encode()
        self.image = 'sha256:' + 'a' * 64
        self.manifest = dict(format=1, epoch='2026-01-01T00:00:00.000Z', tickMs=2000,
                             generation=1, tick=20, imageId=self.image,
                             checkpointSha256=b.digest(self.data), helperHash=b.digest(b.HELPER.encode()))
        (self.stage / 'lontra-world.json').write_bytes(self.data)
        (self.stage / 'lontra-manifest.json').write_text(json.dumps(self.manifest))
        self.calls = []

    def docker(self, args, data=None):
        self.calls.append((args, data))
        if args[0] == 'run' and args[-1] == 'verify':
            return json.dumps(dict(tick=20, epoch=self.manifest['epoch'])).encode()
        return b''

    def test_restore_uses_two_isolated_containers_and_only_disposable_mount(self):
        with patch.object(b, 'secure'), patch.object(b, 'run', self.docker):
            b.verify(self.stage)
        runs = [args for args, data in self.calls if args[0] == 'run']
        self.assertEqual(len(runs), 2)
        for args in runs:
            self.assertEqual(args[args.index('--network') + 1], 'none')
            self.assertEqual(args[args.index('--user') + 1], '1000:1000')
            self.assertIn('--read-only', args)
            self.assertIn('--cap-drop', args)
            self.assertEqual(args.count('--mount'), 1)
            self.assertRegex(args[args.index('--mount') + 1], r'^type=volume,src=lontra-backup-verify-[a-f0-9]{32},dst=/var/lib/lontra$')
            self.assertNotIn('--env-file', args)
            self.assertIn(self.image, args)
            self.assertEqual(args.count('--env'), 3)
        self.assertEqual(runs[0][-1], 'restore')
        self.assertEqual(runs[1][-1], 'verify')
        self.assertEqual(self.calls[-1][0][:2], ['volume', 'rm'])
        self.assertTrue((self.stage / 'lontra-verified.json').exists())

    def test_corruption_never_reaches_docker(self):
        (self.stage / 'lontra-world.json').write_bytes(self.data.replace(b'20,', b'21,'))
        with patch.object(b, 'secure'), patch.object(b, 'run', self.docker):
            with self.assertRaises(ValueError):
                b.verify(self.stage)
        self.assertEqual(self.calls, [])

    def test_failed_restore_cleans_up_and_never_marks_verified(self):
        def fail(args, data=None):
            if args[0] == 'run':
                self.calls.append((args, data))
                raise RuntimeError('restore failure')
            return self.docker(args, data)
        with patch.object(b, 'secure'), patch.object(b, 'run', fail):
            with self.assertRaises(RuntimeError):
                b.verify(self.stage)
        self.assertEqual(self.calls[-2][0][:2], ['rm', '-f'])
        self.assertEqual(self.calls[-1][0][:2], ['volume', 'rm'])
        self.assertFalse((self.stage / 'lontra-verified.json').exists())

    def test_wrong_restored_tick_rejected(self):
        def wrong(args, data=None):
            if args[0] == 'run' and args[-1] == 'verify':
                return b'{"tick":21,"epoch":"2026-01-01T00:00:00.000Z"}'
            return self.docker(args, data)
        with patch.object(b, 'secure'), patch.object(b, 'run', wrong):
            with self.assertRaises(ValueError):
                b.verify(self.stage)
        self.assertFalse((self.stage / 'lontra-verified.json').exists())

    def test_staging_symlink_and_open_permissions_rejected(self):
        (self.stage / 'link').symlink_to(self.stage, target_is_directory=True)
        with self.assertRaises(ValueError):
            b.secure(self.stage / 'link', True)
        self.stage.chmod(0o755)
        with self.assertRaises(ValueError):
            b.secure(self.stage, True)


    def test_snapshot_manifest_has_image_config_and_checkpoint_age_no_secrets(self):
        (self.stage / 'lontra-world.json').unlink()
        (self.stage / 'lontra-manifest.json').unlink()
        config = b.ROOT / 'releases' / ('b' * 40)
        info = dict(Image=self.image, Config=dict(Image='release'), State=dict(Running=True, StartedAt='now'),
                    Mounts=[dict(Destination='/var/lib/lontra', Type='volume', Name='lontra-creek_field-data')])
        def docker(args, data=None):
            self.calls.append((args, data))
            if args[0] == 'compose': return ('c' * 64).encode()
            if args[0] == 'exec': return json.dumps(dict(text=self.data.decode(), mtime='2026-01-01T00:00:00Z')).encode()
            if args[0] == 'inspect': return json.dumps([info]).encode()
            raise AssertionError(args)
        with patch.object(b, 'env_values', return_value=dict(LONTRA_CONFIG_DIR=str(config), LONTRA_IMAGE='release', SECRET='must-not-leak')), patch.object(b, 'secure'), patch.object(Path, 'read_bytes', return_value=b'config'), patch.object(b, 'run', docker):
            b.snapshot(self.stage)
        manifest = json.loads((self.stage / 'lontra-manifest.json').read_text())
        self.assertEqual(manifest['imageId'], self.image)
        self.assertEqual(manifest['sourceVolume'], 'lontra-creek_field-data')
        self.assertGreater(manifest['checkpointAgeSeconds'], 0)
        self.assertIn('compose.shared.yaml', manifest['configHashes'])
        self.assertNotIn('must-not-leak', json.dumps(manifest))
        self.assertEqual((self.stage / 'lontra-world.json').read_bytes(), self.data)
        compose = self.calls[0][0]
        self.assertLess(compose.index(str(config / 'compose.yaml')), compose.index(str(config / 'compose.shared.yaml')))

    def test_snapshot_records_running_image_and_rejects_restart(self):
        config = b.ROOT / 'releases' / ('b' * 40)
        info = dict(Image=self.image, Config=dict(Image='release'), State=dict(Running=True, StartedAt='now'),
                    Mounts=[dict(Destination='/var/lib/lontra', Type='volume', Name='lontra-creek_field-data')])
        count = 0
        def docker(args, data=None):
            nonlocal count
            if args[0] == 'compose': return ('c' * 64).encode()
            if args[0] == 'exec': return json.dumps(dict(text=self.data.decode(), mtime='2026-01-01T00:00:00Z')).encode()
            if args[0] == 'inspect':
                count += 1
                if count == 2: info['State']['StartedAt'] = 'later'
                return json.dumps([info]).encode()
            raise AssertionError(args)
        with patch.object(b, 'env_values', return_value=dict(LONTRA_CONFIG_DIR=str(config), LONTRA_IMAGE='release')), patch.object(b, 'secure'), patch.object(Path, 'read_bytes', return_value=b'config'), patch.object(b, 'run', docker):
            with self.assertRaisesRegex(ValueError, 'restarted'):
                b.snapshot(self.stage)


if __name__ == '__main__':
    unittest.main()
