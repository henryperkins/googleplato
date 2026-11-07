import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// Models the last committed value and a lagging replica. Unsupported operations
// and conditions fail loudly so tests cannot silently bypass atomicity.
export class StaleDocumentClient {
  rows = new Map();
  commands = [];

  async send(command) {
    this.commands.push(command);
    const input = command.input;
    if (command instanceof GetCommand) {
      const row = this.rows.get(JSON.stringify([input.TableName, input.Key.userId, input.Key.dataKey]));
      const item = input.ConsistentRead ? row?.current : row?.previous;
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command instanceof PutCommand) {
      const key = JSON.stringify([input.TableName, input.Item.userId, input.Item.dataKey]);
      const row = this.rows.get(key);
      const current = row?.current;
      let allowed;
      switch (input.ConditionExpression) {
        case 'attribute_not_exists(dataKey)': allowed = !current?.dataKey; break;
        case 'attribute_not_exists(version)': allowed = current?.version === undefined; break;
        case 'version = :v': allowed = current?.version === input.ExpressionAttributeValues[':v']; break;
        case 'attribute_not_exists(version) OR version = :v': allowed = current?.version === undefined || current.version === input.ExpressionAttributeValues[':v']; break;
        default: throw new Error(`Unsupported condition: ${input.ConditionExpression}`);
      }
      if (!allowed) throw Object.assign(new Error('conditional write failed'), { name: 'ConditionalCheckFailedException' });
      this.rows.set(key, { previous: structuredClone(current), current: structuredClone(input.Item) });
      return {};
    }
    throw new Error(`Unsupported command: ${command.constructor.name}`);
  }
}
