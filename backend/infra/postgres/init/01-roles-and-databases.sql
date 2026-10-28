\set ON_ERROR_STOP on
\set ECHO none
\set ECHO_HIDDEN off

-- Leer secretos del entorno sin mostrarlos ni concatenarlos en SQL.
\getenv dev_owner_password AGENDA_DEV_OWNER_PASSWORD
\getenv dev_app_password AGENDA_DEV_APP_PASSWORD
\getenv test_owner_password AGENDA_TEST_OWNER_PASSWORD
\getenv test_app_password AGENDA_TEST_APP_PASSWORD

-- Owners para migraciones; aplicaciones con acceso DML limitado.
CREATE ROLE agenda_dev_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD :'dev_owner_password';
CREATE ROLE agenda_dev_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD :'dev_app_password';
CREATE ROLE agenda_test_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD :'test_owner_password';
CREATE ROLE agenda_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD :'test_app_password';

CREATE DATABASE agenda_dev OWNER agenda_dev_owner TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE agenda_test OWNER agenda_test_owner TEMPLATE template0 ENCODING 'UTF8';

-- Retirar CONNECT, CREATE y TEMP públicos; aislar ambos entornos.
REVOKE ALL ON DATABASE agenda_dev FROM PUBLIC;
REVOKE ALL ON DATABASE agenda_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE agenda_dev TO agenda_dev_app;
GRANT CONNECT ON DATABASE agenda_test TO agenda_test_app;

ALTER DATABASE agenda_dev SET timezone TO 'UTC';
ALTER DATABASE agenda_test SET timezone TO 'UTC';

-- Limitar consultas y transacciones colgadas de las aplicaciones.
ALTER ROLE agenda_dev_app SET statement_timeout = '30s';
ALTER ROLE agenda_dev_app SET lock_timeout = '5s';
ALTER ROLE agenda_dev_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE agenda_test_app SET statement_timeout = '30s';
ALTER ROLE agenda_test_app SET lock_timeout = '5s';
ALTER ROLE agenda_test_app SET idle_in_transaction_session_timeout = '60s';

\connect agenda_dev
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO agenda_dev_owner;
GRANT USAGE ON SCHEMA public TO agenda_dev_app;
-- Las futuras migraciones deben crear objetos con el rol owner correspondiente.
ALTER DEFAULT PRIVILEGES FOR ROLE agenda_dev_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agenda_dev_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agenda_dev_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agenda_dev_app;

\connect agenda_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO agenda_test_owner;
GRANT USAGE ON SCHEMA public TO agenda_test_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agenda_test_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agenda_test_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agenda_test_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agenda_test_app;
