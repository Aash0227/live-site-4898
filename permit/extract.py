"""Permit-set intelligence for a revision: runs the shared 4898.PermitIntel CLI (the QA/QC PDF engine behind a facade) and writes
<revision>/permit.json, <revision>/permit/meta.json and optional low-resolution sheet thumbnails for the viewer's Drawings tab.

    python permit/extract.py --rev <revision folder> --pdf <permit set.pdf> [--model <QA/QC model snapshot.json>] [--thumbs] [--cli <permit-intel.exe>]

The CLI path comes from --cli, env LSV_PERMIT_CLI, or the default build output of the add-in worktree. The PDF is only read.
A failed extraction writes nothing into the revision (exit code != 0).
"""
import argparse, json, os, subprocess, sys, tempfile, time, hashlib

DEFAULT_CLI = r'C:\4898_project\astra_app\4898-automation\4898-permit\src\4898.PermitIntel.Cli\bin\Release\net48\permit-intel.exe'
THUMB_W, THUMB_Q = 600, 70


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def thumbnails(pdf, out_dir, pages):
    import fitz      # PyMuPDF; page by page, never the whole document in memory
    os.makedirs(out_dir, exist_ok=True); done = []
    with fitz.open(pdf) as d:
        for p in pages:
            pg = d[p - 1]; z = THUMB_W / pg.rect.width
            pix = pg.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False)
            pix.save(os.path.join(out_dir, f'p{p}.jpg'), jpg_quality=THUMB_Q); done.append(p); pix = None
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--rev', required=True); ap.add_argument('--pdf', required=True); ap.add_argument('--model')
    ap.add_argument('--cli', default=os.environ.get('LSV_PERMIT_CLI') or DEFAULT_CLI); ap.add_argument('--thumbs', action='store_true')
    a = ap.parse_args()
    for f in (a.rev, a.pdf, a.cli) + ((a.model,) if a.model else ()):
        if not os.path.exists(f): sys.exit(f'not found: {f}')
    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'permit.json')
        cmd = [a.cli, a.pdf, '--out', out] + (['--model', a.model] if a.model else [])
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode or not os.path.exists(out):
            sys.stderr.write(r.stderr[-2000:]); sys.exit(f'permit-intel failed (exit {r.returncode}): nothing written')
        doc = json.load(open(out, encoding='utf-8-sig'))
        summary = json.loads(r.stdout[r.stdout.index('{'):]) if '{' in r.stdout else {}      # the CLI prints one (indented) JSON summary
        os.replace(out, os.path.join(a.rev, 'permit.json'))
    meta = {'tool': doc.get('tool'), 'cli': os.path.basename(a.cli), 'pdf': os.path.basename(a.pdf), 'pdfSha256': doc['source']['sha256'],
            'model': os.path.basename(a.model) if a.model else None, 'extractSeconds': round(time.time() - t0, 1), 'summary': summary, 'thumbnails': []}
    if a.thumbs:
        t1 = time.time(); meta['thumbnails'] = thumbnails(a.pdf, os.path.join(a.rev, 'permit', 'thumbs'), [p['page'] for p in doc['pages']])
        meta['thumbnailSeconds'] = round(time.time() - t1, 1)
    os.makedirs(os.path.join(a.rev, 'permit'), exist_ok=True)
    json.dump(meta, open(os.path.join(a.rev, 'permit', 'meta.json'), 'w'), indent=1)
    print(json.dumps({'written': os.path.join(a.rev, 'permit.json'), **summary, 'thumbnails': len(meta['thumbnails']), 'seconds': meta['extractSeconds']}))


if __name__ == '__main__':
    main()
