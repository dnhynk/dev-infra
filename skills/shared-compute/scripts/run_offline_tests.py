"""Run the offline test suite."""
import argparse
import json
import os
from pathlib import Path
import sys
import unittest


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--pattern', default='test*.py')
    parser.add_argument('--report')
    args=parser.parse_args()
    os.umask(0o077)
    root=Path(__file__).resolve().parents[1]
    sys.path.insert(0,str(root/'scripts'));sys.path.insert(0,str(root/'tests'))
    suite=unittest.defaultTestLoader.discover(str(root/'tests'),pattern=args.pattern)
    result=unittest.TextTestRunner(verbosity=1).run(suite)
    report={'run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped)}
    if args.report: Path(args.report).write_text(json.dumps(report,indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__=='__main__':raise SystemExit(main())
