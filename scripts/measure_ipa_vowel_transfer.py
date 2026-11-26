"""Precompute the standard JD2 65-section reference vowel space."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
import ipa_reference_library
import vowel_response


def main():
    library = ipa_reference_library.LIBRARY
    content = vowel_response.measures(ipa_reference_library.index(), library, 'JD2', force=True)
    target = library / vowel_response.DEFAULT_FILE
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(target)
    print(f'{len(content["records"])} measured, {len(content["omitted"])} omitted')


if __name__ == '__main__':
    main()

