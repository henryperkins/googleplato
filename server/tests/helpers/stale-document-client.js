import { isDeepStrictEqual } from 'node:util';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// Models committed rows and a replica one write behind. Never silently accept
// an unknown expression: that would bypass the adapter's actual atomicity.
export class StaleDocumentClient {
  rows = new Map();
  commands = [];

  key(table, item) {
    if ('dataKey' in item) return JSON.stringify([table, item.userId, item.dataKey]);
    const id = ['inviteToken', 'tokenHash', 'logId', 'userId'].find(k => k in item);
    if (!id) throw new Error(`Unsupported key for ${table}`);
    return JSON.stringify([table, item[id], null]);
  }

  // Only fixture setup advances replicas. Concurrent test writes remain stale.
  commitReplicas() {
    for (const row of this.rows.values()) row.previous = structuredClone(row.current);
  }

  condition(expression, item, names = {}, values = {}) {
    if (!expression) return true;
    const resolve = name => names[name] || name;
    const clauses = expression.split(' OR ').map(or => or.split(' AND ').map(term => {
      let match = /^(attribute_exists|attribute_not_exists)\(([^)]+)\)$/.exec(term);
      if (match) return (item?.[resolve(match[2])] !== undefined) === (match[1] === 'attribute_exists');
      match = /^([#\w]+) = (:\w+)$/.exec(term);
      if (match) return isDeepStrictEqual(item?.[resolve(match[1])], values[match[2]]);
      throw new Error(`Unsupported condition: ${expression}`);
    }));
    return clauses.some(terms => terms.every(Boolean));
  }

  async send(command) {
    this.commands.push(command);
    const input = command.input;
    if (command instanceof GetCommand) {
      const row = this.rows.get(this.key(input.TableName, input.Key));
      const item = input.ConsistentRead ? row?.current : row?.previous;
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command instanceof ScanCommand || command instanceof QueryCommand) {
      if (input.ExclusiveStartKey || input.FilterExpression) throw new Error('Unsupported scan/query options');
      let items = [...this.rows].filter(([key]) => JSON.parse(key)[0] === input.TableName)
        .map(([, row]) => input.ConsistentRead ? row.current : row.previous).filter(Boolean);
      if (command instanceof QueryCommand) {
        if (!['userId = :uid', 'email = :email', 'username = :username'].includes(input.KeyConditionExpression)) {
          throw new Error(`Unsupported query: ${input.KeyConditionExpression}`);
        }
        const [field, value] = input.KeyConditionExpression.split(' = ');
        items = items.filter(item => item[field] === input.ExpressionAttributeValues[value]);
      }
      return { Items: structuredClone(items), Count: items.length };
    }
    if (command instanceof PutCommand || command instanceof UpdateCommand || command instanceof DeleteCommand) {
      const key = this.key(input.TableName, input.Item || input.Key);
      const current = this.rows.get(key)?.current;
      if (!this.condition(input.ConditionExpression, current, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
        throw Object.assign(new Error('conditional write failed'), { name: 'ConditionalCheckFailedException' });
      }
      let item;
      if (command instanceof PutCommand) item = input.Item;
      if (command instanceof UpdateCommand) {
        item = { ...current, ...input.Key };
        if (!input.UpdateExpression.startsWith('SET ')) throw new Error(`Unsupported update: ${input.UpdateExpression}`);
        for (const term of input.UpdateExpression.slice(4).split(', ')) {
          const match = /^([#\w]+) = (:\w+)$/.exec(term);
          if (!match) throw new Error(`Unsupported update: ${input.UpdateExpression}`);
          item[input.ExpressionAttributeNames?.[match[1]] || match[1]] = input.ExpressionAttributeValues[match[2]];
        }
      }
      this.rows.set(key, { previous: structuredClone(current), current: structuredClone(item) });
      return input.ReturnValues === 'ALL_OLD' ? { Attributes: structuredClone(current) } : {};
    }
    throw new Error(`Unsupported command: ${command.constructor.name}`);
  }
}
