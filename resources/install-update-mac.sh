#!/bin/sh
# Arguments are passed directly by spawn; never interpolate app/user paths.
set -eu
source_app=$1
target_app=$2
parent_pid=$3
log_file=$4
exec >>"$log_file" 2>&1
for attempt in $(seq 1 300); do
  if ! kill -0 "$parent_pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if kill -0 "$parent_pid" 2>/dev/null; then echo 'Application did not quit; update cancelled.'; exit 1; fi
staged_app="$(dirname "$target_app")/.NearLink-update-${parent_pid}.app"
backup_app="${target_app}.previous-${parent_pid}"
if [ -e "$staged_app" ] || [ -e "$backup_app" ]; then echo 'An update staging path already exists; update cancelled.'; exit 1; fi
restore() {
  if [ -e "$backup_app" ] && [ ! -e "$target_app" ]; then /bin/mv "$backup_app" "$target_app"; fi
  /bin/rm -rf "$staged_app"
}
trap restore EXIT
trap 'exit 1' HUP INT TERM
test -d "$source_app"
test -d "$target_app"
/usr/bin/ditto "$source_app" "$staged_app"
/usr/bin/codesign --verify --deep --strict "$staged_app"
/bin/mv "$target_app" "$backup_app"
if ! /bin/mv "$staged_app" "$target_app"; then exit 1; fi
/usr/bin/open "$target_app"
# Retain the previous version until the next successful application start.
echo 'Update installed and launch requested.'
