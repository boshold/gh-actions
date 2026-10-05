# Removes SQL comments (--, /* */) and blanks string literals ('…', $$…$$), so destructive-SQL
# patterns neither match prose nor miss code after a "--" inside a string. Keeps "identifiers".
# POSIX awk; state carries across lines.
{
  line = $0; n = length(line); out = ""; i = 1
  while (i <= n) {
    c = substr(line, i, 1); c2 = substr(line, i, 2)
    if (state == "block") {
      if (c2 == "*/") { state = ""; out = out " "; i += 2 } else i++
      continue
    }
    if (state == "squote") {
      if (c == "'") {
        if (substr(line, i + 1, 1) == "'") { i += 2; continue }
        state = ""; out = out "'"
      }
      i++; continue
    }
    if (state == "dollar") {
      if (c2 == "$$") { state = ""; out = out "$$"; i += 2 } else i++
      continue
    }
    if (state == "dquote") {
      out = out c
      if (c == "\"") state = ""
      i++; continue
    }
    if (c2 == "--") break
    if (c2 == "/*") { state = "block"; i += 2; continue }
    if (c2 == "$$") { state = "dollar"; out = out "$$"; i += 2; continue }
    if (c == "'") { state = "squote"; out = out "'"; i++; continue }
    if (c == "\"") { state = "dquote"; out = out c; i++; continue }
    out = out c; i++
  }
  print out
}
