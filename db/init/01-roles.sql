-- Dev only: the app's login role and the test database. Production creates bike_app with its own password.
CREATE ROLE bike_app LOGIN PASSWORD 'bike_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE bike_test OWNER bike;
