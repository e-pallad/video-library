from medialib.search import build_sql, parse


def test_parse_tags_words_and_types():
    p = parse('tag:cats #dogs -tag:"bad one" -#x beach -draft type:videos "exact phrase"')
    assert p.include_tags == ["cats", "dogs"]
    assert p.exclude_tags == ["bad one", "x"]
    assert p.words == ["beach", "exact phrase"]
    assert p.exclude_words == ["draft"]
    assert p.kind == "video"


def test_plain_words_starting_with_prefixes_are_not_operators():
    p = parse("tagline island typewriter")
    assert p.words == ["tagline", "island", "typewriter"]
    assert not p.include_tags and p.kind is None


def test_build_sql_is_parameterised():
    sql, params, *_ = build_sql("tag:x'; DROP TABLE media; -- 100%", sort="bogus")
    assert "DROP" not in sql
    assert "x';" in params
    assert "%100\\%%" in params
