from medialib.search import build_sql, mixed_order, parse


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


def _rows(folders, per_folder):
    # ids are handed out folder by folder, like a scan does
    return [{"id": f * per_folder + i + 1, "root": "/lib", "rel_path": f"folder{f}\\clip{i}.mp4"}
            for f in range(folders) for i in range(per_folder)]


def test_shuffle_does_not_follow_folder_order():
    rows = _rows(4, 25)
    folder = {r["id"]: r["rel_path"].split("\\")[0] for r in rows}
    for seed in range(1, 30):
        order = mixed_order(rows, seed)
        assert sorted(order) == [r["id"] for r in rows]
        # Every folder has one item in each 25th of the list, so the first four come from four folders...
        assert len({folder[i] for i in order[:4]}) == 4
        # ...and one folder never fills a whole page.
        assert max(sum(folder[i] == f for i in order[:24]) for f in set(folder.values())) <= 7


def test_shuffle_is_stable_per_seed():
    rows = _rows(3, 10)
    assert mixed_order(rows, 7) == mixed_order(list(reversed(rows)), 7)
    assert mixed_order(rows, 7) != mixed_order(rows, 8)


def test_shuffle_barely_moves_when_an_item_is_removed():
    rows = _rows(5, 20)
    before = mixed_order(rows, 3)
    gone = before[10]
    after = mixed_order([r for r in rows if r["id"] != gone], 3)
    # Only items of the deleted item's folder can move, so the first page stays nearly the same.
    assert len(set(before[:60]) - {gone} - set(after[:60])) <= 3
