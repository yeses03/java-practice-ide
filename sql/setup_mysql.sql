-- One-time setup for JDBC questions. Run as MySQL root:
--   mysql -uroot -p < sql/setup_mysql.sql
CREATE DATABASE IF NOT EXISTS ri_db;
CREATE USER IF NOT EXISTS 'test'@'localhost' IDENTIFIED BY 'test123';
GRANT ALL PRIVILEGES ON ri_db.* TO 'test'@'localhost';
FLUSH PRIVILEGES;
