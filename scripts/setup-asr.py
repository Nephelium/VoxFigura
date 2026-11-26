"""Install the optional offline recognizer from the command line."""
from argparse import ArgumentParser
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from asr_install import setup_asr  # noqa: E402
from asr_models import DEFAULT_MODEL, MODELS  # noqa: E402


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--model", choices=MODELS, default=DEFAULT_MODEL)
    setup_asr(parser.parse_args().model, lambda message: print(message, flush=True))
    print("本地语音识别安装完成。")
