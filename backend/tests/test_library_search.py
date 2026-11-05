"""Exact indexed substring semantics, including one-character metadata searches."""

import random
import sqlite3

from app.library_search import initialize_search, replace_search, search_conditions


def matches(database, terms):
    clauses, parameters = search_conditions(terms)
    return {
        row[0]
        for row in database.execute(
            "SELECT rowid FROM library_catalog WHERE " + " AND ".join(clauses),
            parameters,
        )
    }


def test_indexes_match_exact_substrings_for_unicode_punctuation_and_short_terms():
    rng = random.Random(71)
    alphabet = 'abCéß-.*_火🔥🧠"\u0301\u200d'
    texts = [
        "".join(rng.choice(alphabet) for _ in range(40)).lower() for _ in range(100)
    ]
    texts.extend(["false\n0\nwarm and cool", "a\nb", "brushed metal\nété", "unrelated"])
    with sqlite3.connect(":memory:") as database:
        database.execute("CREATE TABLE library_catalog(id TEXT)")
        assert initialize_search(database, rebuild=True)
        for rowid, text in enumerate(texts, 1):
            database.execute(
                "INSERT INTO library_catalog(rowid,id) VALUES (?,?)",
                (rowid, str(rowid)),
            )
            replace_search(database, rowid, text)
        for _ in range(300):
            source = rng.choice(texts[:100])
            start = rng.randrange(30)
            term = source[start : start + rng.randint(1, 8)]
            assert matches(database, [term]) == {
                index for index, text in enumerate(texts, 1) if term in text
            }, term
        for terms in (
            ["false", "0"],
            ["brushed", "é"],
            ["ab"],
            ['"'],
            ["暖"],
            ["warm", "cool"],
        ):
            assert matches(database, terms) == {
                index
                for index, text in enumerate(texts, 1)
                if all(term in text for term in terms)
            }


def test_queries_never_read_full_text_or_load_snapshots():
    for terms in (["false"], ["0"], ["false", "0"]):
        clauses, parameters = search_conditions(terms)
        sql = " AND ".join(clauses)
        assert "instr(" not in sql and "images" not in sql and "search_text" not in sql
        assert parameters and "MATCH ?" in sql


def test_replacing_a_record_removes_both_old_long_and_short_terms():
    with sqlite3.connect(":memory:") as database:
        database.execute("CREATE TABLE library_catalog(id TEXT)")
        initialize_search(database, rebuild=True)
        database.execute("INSERT INTO library_catalog VALUES ('record')")
        replace_search(database, 1, "old 0")
        assert matches(database, ["0"]) == matches(database, ["old"]) == {1}
        replace_search(database, 1, "new 9")
        assert matches(database, ["0"]) == matches(database, ["old"]) == set()
        assert matches(database, ["9"]) == matches(database, ["new"]) == {1}
