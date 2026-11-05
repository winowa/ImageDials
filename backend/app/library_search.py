"""Exact substring indexes over lower-cased readable metadata."""

import sqlite3

MIN_TRIGRAM_CHARACTERS = 3
SEARCH_TABLES = ("library_search", "library_search_short")


def short_token(term):
    return "u" + "x".join(format(ord(character), "x") for character in term)


def short_tokens(text):
    """Index distinct single characters and adjacent pairs, not their positions."""
    characters = {character for character in text if not character.isspace()}
    pairs = {
        first + second
        for first, second in zip(text, text[1:])
        if not first.isspace() and not second.isspace()
    }
    return " ".join(sorted(short_token(term) for term in characters | pairs))


def initialize_search(database, rebuild):
    try:
        if rebuild:
            for table in SEARCH_TABLES:
                database.execute(f"DROP TABLE IF EXISTS {table}")
        database.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS library_search USING "
            "fts5(text,tokenize='trigram case_sensitive 1')"
        )
        database.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS library_search_short USING "
            "fts5(tokens,detail=none,columnsize=0)"
        )
        return True
    except sqlite3.OperationalError as error:
        if "no such module" not in str(error) and "tokenizer" not in str(error):
            raise
        return False


def replace_search(database, rowid, text):
    for table in SEARCH_TABLES:
        database.execute(f"DELETE FROM {table} WHERE rowid=?", (rowid,))
    database.execute(
        "INSERT INTO library_search(rowid,text) VALUES (?,?)", (rowid, text)
    )
    database.execute(
        "INSERT INTO library_search_short(rowid,tokens) VALUES (?,?)",
        (rowid, short_tokens(text)),
    )


def remove_search(database, identity):
    for table in SEARCH_TABLES:
        database.execute(
            f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM library_catalog WHERE id=?)",
            (identity,),
        )


def quoted(term):
    return '"' + term.replace('"', '""') + '"'


def search_conditions(terms):
    clauses, parameters = [], []
    long_terms = [term for term in terms if len(term) >= MIN_TRIGRAM_CHARACTERS]
    short_terms = [term for term in terms if len(term) < MIN_TRIGRAM_CHARACTERS]
    if long_terms:
        clauses.append(
            "rowid IN (SELECT rowid FROM library_search WHERE library_search MATCH ?)"
        )
        parameters.append(" AND ".join(quoted(term) for term in long_terms))
    if short_terms:
        clauses.append(
            "rowid IN (SELECT rowid FROM library_search_short WHERE library_search_short MATCH ?)"
        )
        parameters.append(
            " AND ".join(quoted(short_token(term)) for term in short_terms)
        )
    return clauses, parameters
