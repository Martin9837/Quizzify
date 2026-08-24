import { Link } from 'react-router-dom';
import { EmptyState } from '../components/UI.jsx';
import { IconSearch } from '../components/Icons.jsx';

export default function NotFound() {
  return (
    <EmptyState
      icon={<IconSearch size={22} />}
      title="Page not found"
      message="That route does not exist. Try the command palette to find what you need."
      action={<Link to="/" className="btn primary">Back to dashboard</Link>}
    />
  );
}
