import { useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle.jsx';

function PrivacyLink() {
  const navigate = useNavigate();
  return <a href="/privacy" onClick={e => { e.preventDefault(); navigate('/privacy'); }} className="underline hover:no-underline">Privacy</a>;
}

/**
 * The line under a public page's card: a link (Privacy unless the page passes
 * another, or null for none), the plato credit, and the theme toggle, so a
 * visitor can choose the theme before signing in, as in the classroom header.
 * Focus rings take the page text color, which reads on any classroom backdrop.
 */
export default function PublicFooter({ link = <PrivacyLink /> }) {
  return (
    <div className="mt-4 flex items-center gap-1 text-xs" style={{ '--ring': 'currentColor' }}>
      <p>
        {link && <>{link}{' · '}</>}
        Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">plato</a>.
      </p>
      <ThemeToggle />
    </div>
  );
}
