"""VoQS symbols with a creaky source component."""
import unicodedata


def is_creaky_symbol(symbol: str | None) -> bool:
    normalized = unicodedata.normalize('NFD', symbol or '')
    return normalized in ('C', 'C!') or '\u0330' in normalized
