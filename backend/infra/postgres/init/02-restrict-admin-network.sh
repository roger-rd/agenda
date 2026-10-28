#!/bin/sh
# El subshell conserva el entorno del entrypoint si este archivo se sourcea.
(
    set -eu

    hba_file="${PGDATA:?PGDATA debe estar definido}/pg_hba.conf"
    if [ ! -f "$hba_file" ]; then
        printf '%s\n' 'No se encontró pg_hba.conf; se cancela la restricción TCP.' >&2
        exit 1
    fi

    temp_file=$(mktemp "${hba_file}.agenda.XXXXXX")
    trap 'rm -f "$temp_file"' 0
    trap 'exit 1' HUP INT TERM

    # Reubicar las reglas propias antes de la primera regla, sin duplicarlas.
    # Las reglas locales por socket y el resto del archivo se conservan.
    awk '
        BEGIN {
            ipv4 = "host all agenda_admin 0.0.0.0/0 reject"
            ipv6 = "host all agenda_admin ::/0 reject"
        }
        $0 == ipv4 || $0 == ipv6 { next }
        !inserted && /^[[:space:]]*[^[:space:]#]/ {
            print ipv4
            print ipv6
            inserted = 1
        }
        { print }
        END {
            if (!inserted) {
                print ipv4
                print ipv6
            }
        }
    ' "$hba_file" > "$temp_file"

    # Mantener propietario y permisos del archivo original.
    cat "$temp_file" > "$hba_file"
)
