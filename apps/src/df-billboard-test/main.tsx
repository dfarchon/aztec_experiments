import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SiteRoutes } from './routes';
import '../../../shared/styles.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<BrowserRouter><SiteRoutes /></BrowserRouter>);
