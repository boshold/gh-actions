# Removes SQL comments (--, /* */) and blanks string literals ('…', $tag$…$tag$), so destructive-SQL
# patterns neither match prose nor miss code after a "--" inside a string. Keeps "identifiers".
# Bodies of DO [LANGUAGE x] $tag$…$tag$ are executable, so they are kept and scanned.
# POSIX awk; state carries across lines.
function opens_do(text) {
  text = tolower(text)
  return text ~ /(^|[^a-z0-9_$])do[[:space:]]*(language[[:space:]]+([a-z0-9_]+|'[^']*'|"[^"]*")[[:space:]]*)?$/
}
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
      if (substr(line, i, length(dtag)) == dtag) { state = ""; out = out dtag; i += length(dtag) } else i++
      continue
    }
    if (state == "dquote") {
      out = out c
      if (c == "\"") state = ""
      i++; continue
    }
    if (c2 == "--") break
    if (c2 == "/*") { state = "block"; i += 2; continue }
    if (c == "$" && substr(out, length(out), 1) !~ /[A-Za-z0-9_$]/ && match(substr(line, i), /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)) {
      tag = substr(line, i, RLENGTH); i += RLENGTH
      if (dotag != "" && tag == dotag) dotag = ""
      else if (dotag == "" && opens_do(tail " " out)) dotag = tag
      else { state = "dollar"; dtag = tag }
      out = out tag
      continue
    }
    if (c == "'") { state = "squote"; out = out "'"; i++; continue }
    if (c == "\"") { state = "dquote"; out = out c; i++; continue }
    out = out c; i++
  }
  tail = substr(tail " " out, length(tail " " out) - 199)
  print out
}
