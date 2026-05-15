import 'dotenv/config';
import pg from 'pg';

// Empty config tells pg to look for the PG* variables automatically
const pool = new pg.Pool(); 

export default {
  query: (text, params) => pool.query(text, params),
};
