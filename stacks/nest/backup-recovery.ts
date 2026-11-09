export const backupRecoveryScript = String.raw`
import pathlib, subprocess, sys
marker = pathlib.Path(sys.argv[1]) / '.mailbox-backup-restart-required'
if marker.exists():
    if marker.is_symlink() or not marker.is_file():
        raise RuntimeError('Invalid backup recovery marker')
    try:
        for unit in ['rat-king-seaweedfs.service', 'rat-king-celld.service']:
            subprocess.run(['systemctl', '--user', 'start', unit], check=True)
    finally:
        try:
            subprocess.run(['systemctl', '--user', 'start', 'rat-king-storage-grow.timer'], check=True)
        finally:
            subprocess.run(['systemctl', '--user', 'start', 'rat-king-storage-retention.timer'], check=True)
    marker.unlink()
    print('BACKUP_STOP_POST_RECOVERED')
`;
