import 'dotenv/config';
import pg from 'pg';

// empty config tells pg to look for the PG* variables auto
const pool = new pg.Pool(); 

export default {
  query: (text, params) => pool.query(text, params),
};
