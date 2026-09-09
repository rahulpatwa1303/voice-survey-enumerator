#!/usr/bin/env bash
# Post one test record to the deployed demo form via the OpenRosa endpoint.
# Kobo's v1 JSON API is removed (2026); OpenRosa is the path Collect apps use and it works.
# Usage: set KOBO_TOKEN and KOBO_ASSET_UID in .env, then ./hackathon/scripts/kobo_submit.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${KOBO_TOKEN:?set KOBO_TOKEN}"; : "${KOBO_ASSET_UID:?set KOBO_ASSET_UID}"
KC="${KOBO_KC:-https://kc.kobotoolbox.org}"
H=(-H "Authorization: Token $KOBO_TOKEN" -H "X-OpenRosa-Version: 1.0")

# The form id inside the XML must be the asset uid; the version string must match the served XForm.
DL=$(curl -s "${H[@]}" "$KC/formList" | python3 -c '
import sys,re; x=sys.stdin.read(); uid=sys.argv[1]
m=re.search(r"<xform>(?:(?!</xform>).)*?<formID>"+uid+r"</formID>.*?<downloadUrl>(.*?)</downloadUrl>",x,re.S)
print(m.group(1).replace("&amp;","&")) if m else sys.exit("form not in formList; is it deployed?")' "$KOBO_ASSET_UID")
VER=$(curl -s "${H[@]}" "$DL" | python3 -c 'import sys,re;print(re.search(r"<instance>\s*<\w+[^>]*version=\"([^\"]*)\"",sys.stdin.read()).group(1))')
UUID=$(python3 -c 'import uuid;print(uuid.uuid4())')

XML=$(mktemp); trap 'rm -f "$XML"' EXIT
cat > "$XML" <<XMLEOF
<?xml version="1.0"?>
<$KOBO_ASSET_UID id="$KOBO_ASSET_UID" version="$VER">
  <respondent_name>Test Respondent</respondent_name>
  <age>28</age>
  <pregnant>yes</pregnant>
  <months_pregnant>5</months_pregnant>
  <anc_visits>one_to_three</anc_visits>
  <children_under5>1</children_under5>
  <symptoms>fever headache</symptoms>
  <next_visit>2026-10-15</next_visit>
  <meta><instanceID>uuid:$UUID</instanceID></meta>
</$KOBO_ASSET_UID>
XMLEOF
curl -sS -w "\nHTTP %{http_code}\n" -X POST "$KC/submission" "${H[@]}" -F "xml_submission_file=@$XML;type=text/xml"
