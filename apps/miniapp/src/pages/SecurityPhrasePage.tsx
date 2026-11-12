import { useNavigate } from 'react-router-dom';
import { List } from '@telegram-apps/telegram-ui';
import { SecurityPhraseSetup } from '../components/SecurityPhrase.js';

/** 🔐 Security phrase: choose it or change it. */
export function SecurityPhrasePage(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <List>
      <SecurityPhraseSetup onSaved={() => navigate(-1)} />
    </List>
  );
}
