// Optional roster rules share the same generated records on the server and in browsers.
/** @param {Record<string, any>} data @returns {Record<string, any>} */
export function applyRosterVariant(data) {
  if (data?.config?.clemntRosterVersion !== 'modified') return data;
  const variant = data.backups?.rosterVariant;
  if (!variant) throw new Error('Modified Clement roster requires regenerated backups.json');
  const out = { ...data };
  if (data.chess) {
    out.chess = { ...data.chess, ...variant.chess };
    for (const id of ['chess_char_6_14_a', 'chess_char_6_14_b']) {
      if (out.chess[id]) out.chess[id] = { ...out.chess[id], visible: false, isHidden: true };
    }
  }
  if (data.garrisons) out.garrisons = { ...data.garrisons, ...variant.garrisons };
  if (data.bonds) {
    out.bonds = {};
    for (const [id, bond] of Object.entries(data.bonds)) {
      const update = (list) => {
        const members = (list ?? []).filter(member => member !== 'chess_char_6_14_a' && member !== 'chess_char_6_clemnt_a');
        if (id === 'egirShip' || id === 'swiftShip') members.push('chess_char_6_clemnt_a');
        return members;
      };
      out.bonds[id] = { ...bond, members: update(bond.members), visibleMembers: update(bond.visibleMembers) };
    }
  }
  const diy = data.backups.diy;
  out.backups = {
    ...data.backups,
    diy: {
      ...diy,
      ownedPool: [...new Set([...diy.ownedPool.filter(id => id !== 'char_4231_clemnt'), 'char_4042_lumen'])].sort(),
      operators: { ...diy.operators, char_4042_lumen: variant.lumenOperator },
    },
  };
  return out;
}
